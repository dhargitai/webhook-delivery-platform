import {
  type AttemptOutcome,
  type DeliveryJob,
  MAX_ATTEMPTS,
  RetryPolicy,
} from '@wdp/core';
import { MalformedMessageError, RequeueError } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HandledJob } from './job-message-handler.js';
import { RetryHandler } from './retry-handler.js';
import { RetryPublisher } from './retry-publisher.js';

const baseJob: DeliveryJob = {
  deliveryId: 'delivery-1',
  eventId: 'event-1',
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42' },
};

const failed: AttemptOutcome = {
  kind: 'failed',
  failure: 'http_error',
  status: 503,
  latencyMs: 12,
};

/** Stands in for the `JobMessageHandler`: reports what the attempt was. */
class FakeInner {
  job: DeliveryJob = baseJob;
  outcome: AttemptOutcome = failed;
  failWith?: Error;
  calls = 0;

  async handle(_message: ConsumeMessage): Promise<HandledJob> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return { job: this.job, outcome: this.outcome };
  }
}

class FakeRetryPublisher extends RetryPublisher {
  readonly retried: { job: DeliveryJob; delayMs: number }[] = [];
  failWith?: Error;
  private gate?: Promise<void>;
  release?: () => void;

  /** Makes the publish wait, like a broker that has not confirmed yet. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async retry(job: DeliveryJob, delayMs: number): Promise<void> {
    await this.gate;
    if (this.failWith) throw this.failWith;
    this.retried.push({ job, delayMs });
  }
}

const message = {} as ConsumeMessage;

describe('RetryHandler', () => {
  let inner: FakeInner;
  let retries: FakeRetryPublisher;
  let rng: number;
  let handler: RetryHandler;

  beforeEach(() => {
    inner = new FakeInner();
    retries = new FakeRetryPublisher();
    rng = 0.5; // the middle bucket: exactly the base delay
    handler = new RetryHandler(inner, retries, {
      policy: new RetryPolicy(),
      rng: () => rng,
      maxAttempts: MAX_ATTEMPTS,
    });
  });

  it('retries a failed first attempt as attempt 2, in the policy’s tier', async () => {
    await handler.handle(message);

    expect(retries.retried).toEqual([
      { job: { ...baseJob, attemptNo: 2 }, delayMs: 5_000 },
    ]);
  });

  it('takes the jitter bucket from the rng', async () => {
    rng = 0; // 0.8x
    await handler.handle(message);
    rng = 0.99; // 1.2x
    await handler.handle(message);

    expect(retries.retried.map((retry) => retry.delayMs)).toEqual([
      4_000, 6_000,
    ]);
  });

  it.each([
    { attemptNo: 1, nextAttemptNo: 2, delayMs: 5_000 },
    { attemptNo: 2, nextAttemptNo: 3, delayMs: 30_000 },
    { attemptNo: 3, nextAttemptNo: 4, delayMs: 300_000 },
    { attemptNo: 7, nextAttemptNo: 8, delayMs: 36_000_000 },
  ])(
    'climbs the schedule: failed attempt $attemptNo waits $delayMs ms and is retried as $nextAttemptNo',
    async ({ attemptNo, nextAttemptNo, delayMs }) => {
      inner.job = { ...baseJob, attemptNo };

      await handler.handle(message);

      expect(retries.retried).toEqual([
        { job: { ...baseJob, attemptNo: nextAttemptNo }, delayMs },
      ]);
    },
  );

  it('keeps the delivery id, so the webhook-id stays stable across retries', async () => {
    inner.job = { ...baseJob, attemptNo: 4 };

    await handler.handle(message);

    expect(retries.retried[0]?.job.deliveryId).toBe('delivery-1');
  });

  it('reports what it decided', async () => {
    const handled = await handler.handle(message);

    expect(handled).toEqual({
      job: baseJob,
      outcome: failed,
      next: { kind: 'retry', attemptNo: 2, delayMs: 5_000 },
    });
  });

  it('does not resolve before the broker has confirmed the retry, so the ack waits for it', async () => {
    retries.hold();
    let resolved = false;
    const handled = handler.handle(message).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inner.calls).toBe(1);
    expect(resolved).toBe(false);

    retries.release?.();
    await handled;
    expect(resolved).toBe(true);
    expect(retries.retried).toHaveLength(1);
  });

  it('asks for the original to be kept when the retry cannot be published', async () => {
    retries.failWith = new Error('no confirm');

    const rejected = handler.handle(message);

    await expect(rejected).rejects.toBeInstanceOf(RequeueError);
    await expect(rejected).rejects.toMatchObject({
      cause: retries.failWith,
    });
  });

  it.each<AttemptOutcome>([
    { kind: 'delivered', status: 200, latencyMs: 4, snippet: 'ok' },
    { kind: 'skipped', reason: 'endpoint_missing' },
    { kind: 'skipped', reason: 'endpoint_disabled' },
  ])('publishes no retry for a $kind attempt', async (outcome) => {
    inner.outcome = outcome;

    const handled = await handler.handle(message);

    expect(retries.retried).toEqual([]);
    expect(handled.next).toEqual({ kind: 'none' });
  });

  it('gives up after the last attempt: no retry, and it resolves so the job is acked', async () => {
    inner.job = { ...baseJob, attemptNo: MAX_ATTEMPTS };

    const handled = await handler.handle(message);

    expect(retries.retried).toEqual([]);
    expect(handled.next).toEqual({ kind: 'exhausted' });
  });

  it('still retries the attempt before the last', async () => {
    inner.job = { ...baseJob, attemptNo: MAX_ATTEMPTS - 1 };

    await handler.handle(message);

    expect(retries.retried).toHaveLength(1);
    expect(retries.retried[0]?.job.attemptNo).toBe(MAX_ATTEMPTS);
  });

  it('follows the budget it is given, not the policy’s alone', async () => {
    handler = new RetryHandler(inner, retries, {
      policy: new RetryPolicy(),
      rng: () => rng,
      maxAttempts: 2,
    });
    inner.job = { ...baseJob, attemptNo: 2 };

    const handled = await handler.handle(message);

    expect(handled.next).toEqual({ kind: 'exhausted' });
  });

  it('refuses to guess when the policy and the budget disagree', async () => {
    // A budget longer than the schedule: attempt 8 has budget left but no tier.
    handler = new RetryHandler(inner, retries, {
      policy: new RetryPolicy(),
      rng: () => rng,
      maxAttempts: MAX_ATTEMPTS + 1,
    });
    inner.job = { ...baseJob, attemptNo: MAX_ATTEMPTS };

    await expect(handler.handle(message)).rejects.toThrow(/schedule/);
    expect(retries.retried).toEqual([]);
  });

  it('lets an error from the inner handler through and publishes nothing', async () => {
    inner.failWith = new MalformedMessageError('bad body');

    await expect(handler.handle(message)).rejects.toBeInstanceOf(
      MalformedMessageError,
    );
    expect(retries.retried).toEqual([]);
  });

  it('rejects a job whose attempt number is beyond the budget', async () => {
    inner.job = { ...baseJob, attemptNo: MAX_ATTEMPTS + 1 };

    await expect(handler.handle(message)).rejects.toThrow(RangeError);
    expect(retries.retried).toEqual([]);
  });
});
