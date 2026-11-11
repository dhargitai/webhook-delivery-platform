import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayLoop } from './relay-loop.js';

/** A relay that returns the scripted counts in order, then 0 forever. */
class ScriptedRelay {
  calls = 0;
  private gate: Promise<void> | undefined;

  constructor(private readonly script: (number | Error)[] = []) {}

  blockNextRun(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async runOnce(): Promise<number> {
    const step = this.script[this.calls] ?? 0;
    this.calls += 1;
    if (this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
    }
    if (step instanceof Error) throw step;
    return step;
  }
}

describe('RelayLoop', () => {
  const options = {
    batchSize: 5,
    pollIntervalMs: 100,
    errorBackoffMs: 1_000,
  };
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);

  beforeEach(() => {
    vi.useFakeTimers();
    errors.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('runs again at once after a full batch, without sleeping', async () => {
    const relay = new ScriptedRelay([5, 5, 0]);
    const loop = new RelayLoop(relay, { ...options, onError });

    loop.start();
    await settle();

    expect(relay.calls).toBe(3);
    await loop.stop();
  });

  it('sleeps for the poll interval after an empty run', async () => {
    const relay = new ScriptedRelay();
    const loop = new RelayLoop(relay, { ...options, onError });

    loop.start();
    await settle();
    expect(relay.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(relay.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.calls).toBe(2);
    await loop.stop();
  });

  it('also sleeps after a batch smaller than the batch size', async () => {
    const relay = new ScriptedRelay([3]);
    const loop = new RelayLoop(relay, { ...options, onError });

    loop.start();
    await settle();

    expect(relay.calls).toBe(1);
    await loop.stop();
  });

  it('reports an error, backs off, and keeps going', async () => {
    const failure = new Error('broker down');
    const relay = new ScriptedRelay([failure]);
    const loop = new RelayLoop(relay, { ...options, onError });

    loop.start();
    await settle();
    expect(errors).toEqual([failure]);
    expect(relay.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(relay.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.calls).toBe(2);
    await loop.stop();
  });

  it('refuses to start twice', () => {
    const loop = new RelayLoop(new ScriptedRelay(), { ...options, onError });
    loop.start();

    expect(() => loop.start()).toThrow(/already started/i);
  });

  describe('stop', () => {
    it('wakes a sleeping loop instead of waiting out the interval', async () => {
      const relay = new ScriptedRelay();
      const loop = new RelayLoop(relay, {
        ...options,
        pollIntervalMs: 60_000,
        onError,
      });
      loop.start();
      await settle();

      // No timer advance: only the abort can end the 60 s sleep.
      await expect(loop.stop()).resolves.toBeUndefined();
    });

    it('waits for the batch in flight and then runs no more', async () => {
      const relay = new ScriptedRelay([5, 5, 5]);
      const release = relay.blockNextRun();
      const loop = new RelayLoop(relay, { ...options, onError });
      loop.start();
      await settle();
      expect(relay.calls).toBe(1);

      let stopped = false;
      const stopping = loop.stop().then(() => {
        stopped = true;
      });
      await settle();
      expect(stopped).toBe(false);

      release();
      await stopping;

      await vi.advanceTimersByTimeAsync(10_000);
      expect(relay.calls).toBe(1);
    });

    it('can be called when the loop never started', async () => {
      const loop = new RelayLoop(new ScriptedRelay(), { ...options, onError });

      await expect(loop.stop()).resolves.toBeUndefined();
    });
  });
});
