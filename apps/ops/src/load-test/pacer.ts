export interface PacerClock {
  /** Milliseconds, monotonic. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface OpenLoopOptions {
  ratePerSecond: number;
  durationSeconds: number;
  /** One request. Its outcome is the caller's to record; a rejection is only counted. */
  send: (index: number) => Promise<void>;
  clock: PacerClock;
}

export interface OpenLoopResult {
  sent: number;
  /** Sends that threw or rejected (network errors, not HTTP statuses). */
  failed: number;
  /**
   * The latest any send fired after its scheduled time. A large value means
   * the generator, not the system under test, limited the offered load.
   */
  maxLagMs: number;
}

/**
 * Sends at a fixed rate for a fixed time without waiting for responses (an
 * open loop). A closed loop, which sends the next request only once one
 * answers, offers less load exactly when the system slows down, and so hides
 * the latency it was meant to measure (coordinated omission). When the pacer
 * falls behind, overdue sends go out at once rather than being skipped, so the
 * total stays `rate x duration`.
 */
export async function runOpenLoop({
  ratePerSecond,
  durationSeconds,
  send,
  clock,
}: OpenLoopOptions): Promise<OpenLoopResult> {
  for (const [name, value] of [
    ['ratePerSecond', ratePerSecond],
    ['durationSeconds', durationSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got ${value}`);
    }
  }

  const total = ratePerSecond * durationSeconds;
  const intervalMs = 1_000 / ratePerSecond;
  const start = clock.now();
  const inFlight: Promise<void>[] = [];
  let failed = 0;
  let maxLagMs = 0;

  for (let index = 0; index < total; index++) {
    const due = start + index * intervalMs;
    const wait = due - clock.now();
    if (wait > 0) {
      await clock.sleep(wait);
    }
    maxLagMs = Math.max(maxLagMs, clock.now() - due);
    inFlight.push(
      fire(send, index).catch(() => {
        failed += 1;
      }),
    );
  }

  await Promise.all(inFlight);
  return { sent: total, failed, maxLagMs };
}

/**
 * Starts a send now, not on a later tick, so it fires at its scheduled time;
 * a send that throws before returning a promise becomes a rejection, counted
 * like any other instead of ending the run.
 */
function fire(
  send: (index: number) => Promise<void>,
  index: number,
): Promise<void> {
  try {
    return send(index);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** Wall-clock time from the monotonic `performance.now()`. */
export const systemClock: PacerClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
