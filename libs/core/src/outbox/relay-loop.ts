export interface RelayLoopOptions {
  /** The batch size the relay uses: a run that fills it means more is waiting. */
  batchSize: number;
  /** Pause after a run that did not fill a batch (PRD: 100 ms). */
  pollIntervalMs: number;
  /** Pause after a failed run, so a broker outage is not hammered. */
  errorBackoffMs: number;
  /** Where failures go. The loop keeps running regardless. Must not throw. */
  onError: (error: unknown) => void;
}

/** Sleeps, but wakes early when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Runs the relay continuously: straight on after a full batch, after a pause
 * otherwise. `stop()` is graceful: it lets the batch in flight finish.
 */
export class RelayLoop {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly relay: { runOnce(): Promise<number> },
    private readonly options: RelayLoopOptions,
  ) {}

  start(): void {
    if (this.running) {
      throw new Error('RelayLoop already started');
    }
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;
    while (!signal.aborted) {
      let published: number;
      try {
        published = await this.relay.runOnce();
      } catch (error) {
        this.options.onError(error);
        await sleep(this.options.errorBackoffMs, signal);
        continue;
      }
      if (published < this.options.batchSize) {
        await sleep(this.options.pollIntervalMs, signal);
      }
    }
  }
}
