import { describe, expect, it } from 'vitest';
import {
  buildReport,
  type ExpectedDelivery,
  type FirstAttempt,
  formatMarkdown,
  type ReportInput,
} from './report.js';

// UUIDv7 ids whose embedded time is `ACCEPTED_MS` (0x01a22206ca7b), so the
// latency of each delivery is exactly `ts - ACCEPTED_MS`.
const ACCEPTED_MS = 1_795_867_200_123;
const eventId = (n: number) =>
  `01a22206-ca7b-7000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (latencyMs: number) => new Date(ACCEPTED_MS + latencyMs);

const hanging = (n: number, endpointId = 'ep-hang-lane'): ExpectedDelivery => ({
  eventId: eventId(n),
  endpointId,
  onHangingLane: true,
});
const other = (n: number, endpointId = 'ep-other-lane'): ExpectedDelivery => ({
  eventId: eventId(n),
  endpointId,
  onHangingLane: false,
});
const attempt = (
  delivery: ExpectedDelivery,
  latencyMs: number,
): FirstAttempt => ({
  eventId: delivery.eventId,
  endpointId: delivery.endpointId,
  ts: at(latencyMs),
});

/** One delivery per lane group, both fast, at 600 accepted events/s. */
function passingInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const a = hanging(1);
  const b = other(2);
  return {
    run: {
      label: 'test',
      // Far from the events' embedded time on purpose: latency must be taken
      // from each event's own acceptance time, not from the run start.
      startedAt: new Date(ACCEPTED_MS - 3_600_000),
      durationSeconds: 10,
    },
    ingest: {
      accepted: 6_000,
      noisyRateLimited: 42,
      victimRateLimited: 0,
      failed: 0,
    },
    generatorMaxLagMs: 3,
    expected: [a, b],
    firstAttempts: [attempt(a, 100), attempt(b, 200)],
    ...overrides,
  };
}

describe('buildReport', () => {
  it('measures each delivery from its event acceptance time to its first attempt', () => {
    const report = buildReport(passingInput());

    expect(report.hangingLane).toMatchObject({ count: 1, p99: 100 });
    expect(report.otherLanes).toMatchObject({ count: 1, p99: 200 });
    expect(report.verdict).toEqual({ pass: true, reasons: [] });
  });

  it('reports the accepted rate and the rate-limited count', () => {
    const report = buildReport(passingInput());

    expect(report.acceptedPerSecond).toBe(600);
    expect(report.noisyRateLimited).toBe(42);
    expect(report.generatorMaxLagMs).toBe(3);
  });

  it('fails when a victim send failed, since its event was never accepted', () => {
    const report = buildReport(
      passingInput({
        ingest: {
          accepted: 6_000,
          noisyRateLimited: 42,
          victimRateLimited: 0,
          failed: 2,
        },
      }),
    );

    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/2 victim sends failed/),
    ]);
  });

  it('fails when a victim was rate limited, since the scenario let it exceed its limit', () => {
    const report = buildReport(
      passingInput({
        ingest: {
          accepted: 6_000,
          noisyRateLimited: 42,
          victimRateLimited: 1,
          failed: 0,
        },
      }),
    );

    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/victims were rate limited 1 time/),
    ]);
  });

  it('fails when an accepted delivery never had a first attempt', () => {
    const delivered = other(2);
    const lost = other(3);
    const report = buildReport(
      passingInput({
        expected: [hanging(1), delivered, lost],
        firstAttempts: [attempt(hanging(1), 100), attempt(delivered, 200)],
      }),
    );

    expect(report.missing).toBe(1);
    expect(report.missingSample).toEqual([lost]);
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/1 accepted delivery had no first attempt/),
    ]);
  });

  it('fails on a slow hanging lane even when the other lanes are fast', () => {
    const slow = hanging(1);
    const fast = Array.from({ length: 99 }, (_, i) => other(i + 2));
    const report = buildReport(
      passingInput({
        expected: [slow, ...fast],
        firstAttempts: [
          attempt(slow, 9_000),
          ...fast.map((d) => attempt(d, 50)),
        ],
      }),
    );

    expect(report.otherLanes.p99).toBe(50);
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/hanging endpoint's lane.*9000 ms/),
    ]);
  });

  it('fails when the other lanes break the SLA', () => {
    const slow = other(2);
    const report = buildReport(
      passingInput({
        expected: [hanging(1), slow],
        firstAttempts: [attempt(hanging(1), 100), attempt(slow, 5_001)],
      }),
    );

    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/other lanes.*5001 ms/),
    ]);
  });

  it('passes at exactly 5000 ms', () => {
    const edge = other(2);
    const report = buildReport(
      passingInput({
        expected: [hanging(1), edge],
        firstAttempts: [attempt(hanging(1), 5_000), attempt(edge, 5_000)],
      }),
    );

    expect(report.verdict.pass).toBe(true);
  });

  it.each([
    { accepted: 4_990, pass: false },
    { accepted: 5_000, pass: true },
  ])(
    'needs at least 500 accepted events/s ($accepted in 10 s: pass $pass)',
    ({ accepted, pass }) => {
      const report = buildReport(
        passingInput({
          ingest: {
            accepted,
            noisyRateLimited: 0,
            victimRateLimited: 0,
            failed: 0,
          },
        }),
      );

      expect(report.verdict.pass).toBe(pass);
      if (!pass) {
        expect(report.verdict.reasons).toEqual([
          expect.stringMatching(/499 accepted events\/s/),
        ]);
      }
    },
  );

  it('fails when no delivery shared the hanging endpoint lane', () => {
    // Without one, the run proves nothing about isolation on that lane.
    const b = other(2);
    const report = buildReport(
      passingInput({ expected: [b], firstAttempts: [attempt(b, 100)] }),
    );

    expect(report.hangingLane.count).toBe(0);
    expect(report.verdict.reasons).toEqual([
      expect.stringMatching(/no delivery on the hanging endpoint's lane/),
    ]);
  });

  it('ignores first attempts of deliveries the run did not expect', () => {
    const report = buildReport(
      passingInput({
        firstAttempts: [
          ...passingInput().firstAttempts,
          // Another endpoint of the same event, and an unrelated event.
          attempt(other(2, 'ep-not-in-run'), 60_000),
          attempt(other(99), 60_000),
        ],
      }),
    );

    expect(report.hangingLane.count).toBe(1);
    expect(report.otherLanes).toMatchObject({ count: 1, max: 200 });
  });

  it('counts a redelivered first attempt once, at its earliest time', () => {
    // At-least-once: a worker crash can log attempt 1 of a delivery twice.
    const b = other(2);
    const report = buildReport(
      passingInput({
        firstAttempts: [
          attempt(hanging(1), 100),
          attempt(b, 7_000),
          attempt(b, 200),
        ],
      }),
    );

    expect(report.otherLanes).toMatchObject({ count: 1, max: 200 });
  });
});

describe('formatMarkdown', () => {
  it('shows both lane groups, the ingest numbers and the verdict', () => {
    const markdown = formatMarkdown(buildReport(passingInput()));

    expect(markdown).toMatch(
      /Hanging endpoint's lane \| 1 \| 100 \| 100 \| 100 \| 100/,
    );
    expect(markdown).toMatch(/Other lanes \| 1 \| 200 \| 200 \| 200 \| 200/);
    expect(markdown).toMatch(/Accepted events\/s: 600/);
    expect(markdown).toMatch(/Noisy tenant rate limited \(429\): 42/);
    expect(markdown).toMatch(/Victims rate limited \(429\): 0/);
    expect(markdown).toMatch(/Failed victim sends: 0/);
    expect(markdown).toMatch(/Generator max lag: 3 ms/);
    expect(markdown).toMatch(/Verdict: PASS/);
  });

  it('lists the reasons of a failure', () => {
    const b = other(2);
    const markdown = formatMarkdown(
      buildReport(
        passingInput({ expected: [b], firstAttempts: [attempt(b, 100)] }),
      ),
    );

    expect(markdown).toMatch(/Verdict: FAIL/);
    expect(markdown).toMatch(/- no delivery on the hanging endpoint's lane/);
  });
});
