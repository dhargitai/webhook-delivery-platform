import { MalformedMessageError, RequeueError } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { DispatchFailureHandler } from './dispatch-failure-handler.js';
import { DispatchRetryPublisher } from './dispatch-retry-publisher.js';

/** Records every call, in order, together with what the handler had done by then. */
class FakeRetryPublisher extends DispatchRetryPublisher {
  readonly calls: string[] = [];
  readonly retried: { message: ConsumeMessage; attempt: number }[] = [];
  readonly deadLettered: { message: ConsumeMessage; reason: string }[] = [];
  failWith: Error | undefined;

  // Like a broker confirm, a publish completes a moment after it is called, so
  // a handler that does not wait for it returns too early to see it recorded.
  async retry(message: ConsumeMessage, attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failWith) throw this.failWith;
    this.calls.push('retry');
    this.retried.push({ message, attempt });
  }

  async deadLetter(message: ConsumeMessage, reason: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failWith) throw this.failWith;
    this.calls.push('deadLetter');
    this.deadLettered.push({ message, reason });
  }
}

const message = (headers?: Record<string, unknown>) =>
  ({ content: Buffer.from('{}'), properties: { headers } }) as ConsumeMessage;

describe('DispatchFailureHandler', () => {
  let retries: FakeRetryPublisher;
  let inner: { failWith: Error | undefined; handled: number };
  let events: string[];
  let handler: DispatchFailureHandler;
  const MAX = 3;

  beforeEach(() => {
    retries = new FakeRetryPublisher();
    inner = { failWith: undefined, handled: 0 };
    events = [];
    handler = new DispatchFailureHandler(
      {
        async handle() {
          inner.handled += 1;
          if (inner.failWith) throw inner.failWith;
          return 2;
        },
      },
      retries,
      {
        maxAttempts: MAX,
        onRetryScheduled: (_m, attempt) => events.push(`retry:${attempt}`),
        onExhausted: (_m, attempts) => events.push(`exhausted:${attempts}`),
      },
    );
  });

  it('returns what the dispatch produced and parks nothing when it succeeds', async () => {
    await expect(handler.handle(message())).resolves.toBe(2);

    expect(retries.calls).toEqual([]);
  });

  it('parks the event for the next attempt when the first dispatch fails', async () => {
    inner.failWith = new Error('confirm timed out');
    const original = message();

    await expect(handler.handle(original)).resolves.toBeUndefined();

    expect(retries.retried).toEqual([{ message: original, attempt: 2 }]);
    expect(retries.deadLettered).toEqual([]);
    expect(events).toEqual(['retry:2']);
  });

  it('counts on from the attempt number the message carries', async () => {
    inner.failWith = new Error('lookup failed');

    await handler.handle(message({ 'x-dispatch-attempt': 2 }));

    expect(retries.retried.map((r) => r.attempt)).toEqual([3]);
  });

  it.each([
    { name: 'a text', header: 'two' },
    { name: 'a fraction', header: 1.5 },
    { name: 'zero', header: 0 },
    { name: 'a negative number', header: -4 },
  ])(
    'treats $name as the attempt header as the first attempt',
    async ({ header }) => {
      inner.failWith = new Error('boom');

      await handler.handle(message({ 'x-dispatch-attempt': header }));

      expect(retries.retried.map((r) => r.attempt)).toEqual([2]);
    },
  );

  it('gives up with the reason once the attempts are used up, instead of retrying forever', async () => {
    inner.failWith = new Error('postgres is down');
    const last = message({ 'x-dispatch-attempt': MAX });

    await expect(handler.handle(last)).resolves.toBeUndefined();

    expect(retries.retried).toEqual([]);
    expect(retries.deadLettered).toEqual([
      { message: last, reason: 'postgres is down' },
    ]);
    expect(events).toEqual([`exhausted:${MAX}`]);
  });

  it('puts the root cause in the reason, not just the wrapper error', async () => {
    inner.failWith = new Error('1 of 2 delivery jobs could not be published', {
      cause: new Error('no broker confirm within 5000 ms'),
    });

    await handler.handle(message({ 'x-dispatch-attempt': MAX }));

    expect(retries.deadLettered[0]?.reason).toBe(
      '1 of 2 delivery jobs could not be published: no broker confirm within 5000 ms',
    );
  });

  it('still retries on the attempt just below the limit', async () => {
    inner.failWith = new Error('boom');

    await handler.handle(message({ 'x-dispatch-attempt': MAX - 1 }));

    expect(retries.retried.map((r) => r.attempt)).toEqual([MAX]);
    expect(retries.deadLettered).toEqual([]);
  });

  it('rethrows a malformed message, so it is dead-lettered at once and never retried', async () => {
    inner.failWith = new MalformedMessageError(
      'message body is not valid JSON',
    );

    await expect(handler.handle(message())).rejects.toBeInstanceOf(
      MalformedMessageError,
    );

    expect(retries.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each(['retry', 'dead-letter'])(
    'asks for a requeue when it cannot %s the event, so the event is not lost',
    async (path) => {
      inner.failWith = new Error('boom');
      retries.failWith = new Error('broker did not confirm');
      const msg =
        path === 'retry' ? message() : message({ 'x-dispatch-attempt': MAX });

      const failure = await handler
        .handle(msg)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RequeueError);
      expect((failure as Error).cause).toBe(retries.failWith);
      expect(events).toEqual([]);
    },
  );
});
