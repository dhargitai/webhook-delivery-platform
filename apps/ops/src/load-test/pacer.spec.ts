import { describe, expect, it } from 'vitest';
import { type PacerClock, runOpenLoop } from './pacer.js';

/**
 * A clock that moves only when the pacer sleeps. `extraOnSleep` adds time to
 * the nth sleep (1-based), as a stalled event loop would.
 */
class FakeClock implements PacerClock {
  private t = 0;
  private sleeps = 0;

  constructor(private readonly extraOnSleep = new Map<number, number>()) {}

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    this.t += ms + (this.extraOnSleep.get(this.sleeps) ?? 0);
    return Promise.resolve();
  }
}

/** Records when each send fired, by the fake clock. */
function recorder(clock: PacerClock) {
  const firedAt: number[] = [];
  const send = (index: number) => {
    firedAt[index] = clock.now();
    return Promise.resolve();
  };
  return { firedAt, send };
}

describe('runOpenLoop', () => {
  it('fires rate x duration sends at evenly spaced times', async () => {
    const clock = new FakeClock();
    const { firedAt, send } = recorder(clock);

    const result = await runOpenLoop({
      ratePerSecond: 10,
      durationSeconds: 1,
      send,
      clock,
    });

    expect(firedAt).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(result).toEqual({ sent: 10, failed: 0, maxLagMs: 0 });
  });

  it('keeps to the schedule while earlier sends have not answered', async () => {
    // Open loop: waiting for responses would lower the offered load exactly
    // when the system under test slows down (coordinated omission).
    const clock = new FakeClock();
    const firedAt: number[] = [];
    const releases: (() => void)[] = [];
    let finished = false;

    const run = runOpenLoop({
      ratePerSecond: 10,
      durationSeconds: 1,
      clock,
      send: (index) => {
        firedAt[index] = clock.now();
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    }).then((result) => {
      finished = true;
      return result;
    });

    // Let the loop run as far as it can without any send answering.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(firedAt).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(finished).toBe(false);

    for (const release of releases) release();
    await expect(run).resolves.toEqual({ sent: 10, failed: 0, maxLagMs: 0 });
  });

  it('fires overdue sends at once, skipping none, and reports the lag', async () => {
    // The sleep before send 3 overruns by 250 ms: sends 3 to 5 are all due by
    // then and go out together; send 6 is back on schedule.
    const clock = new FakeClock(new Map([[3, 250]]));
    const { firedAt, send } = recorder(clock);

    const result = await runOpenLoop({
      ratePerSecond: 10,
      durationSeconds: 1,
      send,
      clock,
    });

    expect(firedAt).toEqual([0, 100, 200, 550, 550, 550, 600, 700, 800, 900]);
    expect(result).toEqual({ sent: 10, failed: 0, maxLagMs: 250 });
  });

  it('counts a failed send and carries on', async () => {
    const clock = new FakeClock();
    const fired: number[] = [];

    const result = await runOpenLoop({
      ratePerSecond: 5,
      durationSeconds: 1,
      clock,
      send: (index) => {
        fired.push(index);
        if (index === 1) throw new Error('thrown before any await');
        return index === 3
          ? Promise.reject(new Error('connection refused'))
          : Promise.resolve();
      },
    });

    expect(fired).toEqual([0, 1, 2, 3, 4]);
    expect(result).toEqual({ sent: 5, failed: 2, maxLagMs: 0 });
  });

  it.each([
    { name: 'a zero rate', ratePerSecond: 0, durationSeconds: 1 },
    { name: 'a negative duration', ratePerSecond: 1, durationSeconds: -1 },
    { name: 'a fractional rate', ratePerSecond: 1.5, durationSeconds: 1 },
  ])('rejects $name', async ({ ratePerSecond, durationSeconds }) => {
    const clock = new FakeClock();
    await expect(
      runOpenLoop({
        ratePerSecond,
        durationSeconds,
        clock,
        send: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
