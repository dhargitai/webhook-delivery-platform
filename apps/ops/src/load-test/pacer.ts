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
  /**
   * Most sends left unanswered at once (unbounded by default). A send due
   * while this many are open is dropped and counted, as load tools count
   * dropped iterations, rather than queued in the generator's memory.
   */
  maxOutstanding?: number;
}

export interface OpenLoopResult {
  sent: number;
  /** Sends due while `maxOutstanding` were open: offered, never sent. */
  dropped: number;
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
  maxOutstanding = Number.POSITIVE_INFINITY,
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
  let dropped = 0;
  let outstanding = 0;
  let maxLagMs = 0;

  for (let index = 0; index < total; index++) {
    const due = start + index * intervalMs;
    // Always through the event loop, even when overdue: firing a backlog in
    // one synchronous run would read no response meanwhile, then land every
    // request at once as a burst the plan never offered.
    await clock.sleep(Math.max(0, due - clock.now()));
    maxLagMs = Math.max(maxLagMs, clock.now() - due);
    if (outstanding >= maxOutstanding) {
      dropped += 1;
      continue;
    }
    outstanding += 1;
    inFlight.push(
      fire(send, index).then(
        () => {
          outstanding -= 1;
        },
        () => {
          outstanding -= 1;
          failed += 1;
        },
      ),
    );
  }

  await Promise.all(inFlight);
  return { sent: total - dropped, dropped, failed, maxLagMs };
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
  // A zero wait only yields (`setImmediate`, after pending I/O), rather than
  // paying `setTimeout`'s 1 ms minimum on every overdue send.
  sleep: (ms) =>
    new Promise((resolve) =>
      ms <= 0 ? setImmediate(resolve) : setTimeout(resolve, ms),
    ),
};
