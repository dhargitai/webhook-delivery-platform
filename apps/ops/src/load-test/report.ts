import { type LatencySummary, summarize } from './percentiles.js';
import { uuidV7Millis } from './uuid-v7-time.js';

/** The PRD's first-attempt SLA (p99) and the task's ingest target. */
const SLA_P99_MS = 5_000;
const MIN_ACCEPTED_PER_SECOND = 500;
const MISSING_SAMPLE_SIZE = 10;

/** One delivery a victim tenant's accepted event must produce. */
export interface ExpectedDelivery {
  eventId: string;
  endpointId: string;
  /** Whether its endpoint shares a fresh lane with the hanging endpoint. */
  onHangingLane: boolean;
}

/** An `attempt_no: 1` document of the attempt log. */
export interface FirstAttempt {
  eventId: string;
  endpointId: string;
  /** When the attempt started. */
  ts: Date;
}

export interface ReportInput {
  run: { label: string; startedAt: Date; durationSeconds: number };
  /** `202`s of every tenant, the noisy one's included, and its `429`s. */
  ingest: { accepted: number; rateLimited: number };
  expected: readonly ExpectedDelivery[];
  firstAttempts: readonly FirstAttempt[];
}

export interface LoadReport {
  run: { label: string; startedAt: string; durationSeconds: number };
  acceptedPerSecond: number;
  rateLimited: number;
  hangingLane: LatencySummary;
  otherLanes: LatencySummary;
  missing: number;
  missingSample: ExpectedDelivery[];
  verdict: { pass: boolean; reasons: string[] };
}

const key = (eventId: string, endpointId: string) => `${eventId}|${endpointId}`;

/**
 * Judges a run. A delivery's latency is from its event's acceptance (the time
 * in its UUIDv7) to the start of its first attempt, so time spent parked by
 * the limiter or the breaker counts. Victims on the hanging endpoint's lane
 * are summarised apart from the rest, so a blended p99 cannot hide a stalled
 * lane, and an accepted delivery that never had an attempt fails the run
 * rather than vanishing from the percentiles.
 */
export function buildReport(input: ReportInput): LoadReport {
  // Earliest first attempt per delivery: at-least-once delivery can log
  // attempt 1 twice when a worker dies before its ack.
  const firstAt = new Map<string, number>();
  for (const { eventId, endpointId, ts } of input.firstAttempts) {
    const k = key(eventId, endpointId);
    const earliest = firstAt.get(k);
    if (earliest === undefined || ts.getTime() < earliest) {
      firstAt.set(k, ts.getTime());
    }
  }

  const hangingLatencies: number[] = [];
  const otherLatencies: number[] = [];
  const missing: ExpectedDelivery[] = [];
  for (const delivery of input.expected) {
    const started = firstAt.get(key(delivery.eventId, delivery.endpointId));
    if (started === undefined) {
      missing.push(delivery);
      continue;
    }
    const latency = started - uuidV7Millis(delivery.eventId);
    (delivery.onHangingLane ? hangingLatencies : otherLatencies).push(latency);
  }

  const hangingLane = summarize(hangingLatencies);
  const otherLanes = summarize(otherLatencies);
  const acceptedPerSecond = input.ingest.accepted / input.run.durationSeconds;

  const reasons: string[] = [];
  if (hangingLane.p99 === null) {
    reasons.push(
      "no delivery on the hanging endpoint's lane was measured, so its isolation is unproven",
    );
  } else if (hangingLane.p99 > SLA_P99_MS) {
    reasons.push(
      `p99 on the hanging endpoint's lane is ${hangingLane.p99} ms, above ${SLA_P99_MS} ms`,
    );
  }
  if (otherLanes.p99 !== null && otherLanes.p99 > SLA_P99_MS) {
    reasons.push(
      `p99 on the other lanes is ${otherLanes.p99} ms, above ${SLA_P99_MS} ms`,
    );
  }
  if (acceptedPerSecond < MIN_ACCEPTED_PER_SECOND) {
    reasons.push(
      `${round(acceptedPerSecond)} accepted events/s, below ${MIN_ACCEPTED_PER_SECOND}`,
    );
  }
  if (missing.length > 0) {
    reasons.push(
      `${missing.length} accepted ${missing.length === 1 ? 'delivery' : 'deliveries'} had no first attempt`,
    );
  }

  return {
    run: {
      label: input.run.label,
      startedAt: input.run.startedAt.toISOString(),
      durationSeconds: input.run.durationSeconds,
    },
    acceptedPerSecond: round(acceptedPerSecond),
    rateLimited: input.ingest.rateLimited,
    hangingLane,
    otherLanes,
    missing: missing.length,
    missingSample: missing.slice(0, MISSING_SAMPLE_SIZE),
    verdict: { pass: reasons.length === 0, reasons },
  };
}

/** The run as the README's results table shows it. */
export function formatMarkdown(report: LoadReport): string {
  const cell = (value: number | null) => (value === null ? '–' : String(value));
  const row = (name: string, s: LatencySummary) =>
    `| ${name} | ${s.count} | ${cell(s.p50)} | ${cell(s.p95)} | ${cell(s.p99)} | ${cell(s.max)} |`;
  return [
    `Run "${report.run.label}", ${report.run.durationSeconds} s from ${report.run.startedAt}`,
    '',
    `Accepted events/s: ${report.acceptedPerSecond}`,
    `Rate limited (429): ${report.rateLimited}`,
    `Missing deliveries: ${report.missing}`,
    '',
    '| Victim deliveries | Count | p50 ms | p95 ms | p99 ms | Max ms |',
    '| --- | --- | --- | --- | --- | --- |',
    row("Hanging endpoint's lane", report.hangingLane),
    row('Other lanes', report.otherLanes),
    '',
    `Verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'}`,
    ...report.verdict.reasons.map((reason) => `- ${reason}`),
    '',
  ].join('\n');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
