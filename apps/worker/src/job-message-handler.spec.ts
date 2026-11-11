import type { AttemptOutcome, DeliveryJob } from '@wdp/core';
import { encodeMessage, MalformedMessageError } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobMessageHandler } from './job-message-handler.js';

class FakeAttempt {
  readonly jobs: DeliveryJob[] = [];
  outcome: AttemptOutcome = {
    kind: 'delivered',
    status: 200,
    latencyMs: 5,
    snippet: 'ok',
  };
  failWith?: Error;
  /** When set, `attempt` stays pending until this is called. */
  release?: () => void;
  private gate?: Promise<void>;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async attempt(job: DeliveryJob): Promise<AttemptOutcome> {
    this.jobs.push(job);
    await this.gate;
    if (this.failWith) throw this.failWith;
    return this.outcome;
  }
}

const valid = {
  deliveryId: 'delivery-1',
  eventId: 'event-1',
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42' },
};

const message = (body: Buffer) => ({ content: body }) as ConsumeMessage;

describe('JobMessageHandler', () => {
  let delivery: FakeAttempt;
  let handler: JobMessageHandler;

  beforeEach(() => {
    delivery = new FakeAttempt();
    handler = new JobMessageHandler(delivery);
  });

  it('hands the decoded job to the attempt', async () => {
    await handler.handle(message(encodeMessage(valid)));

    expect(delivery.jobs).toEqual([valid]);
  });

  it('returns the job with the outcome of the attempt', async () => {
    const result = await handler.handle(message(encodeMessage(valid)));

    expect(result).toEqual({
      job: valid,
      outcome: { kind: 'delivered', status: 200, latencyMs: 5, snippet: 'ok' },
    });
  });

  it.each<AttemptOutcome>([
    { kind: 'delivered', status: 204, latencyMs: 3, snippet: '' },
    { kind: 'failed', failure: 'timeout', latencyMs: 10_000 },
    { kind: 'skipped', reason: 'endpoint_missing' },
    { kind: 'skipped', reason: 'endpoint_disabled' },
  ])(
    'resolves normally for a $kind attempt, which is what acks it',
    async (outcome) => {
      delivery.outcome = outcome;

      const result = await handler.handle(message(encodeMessage(valid)));

      expect(result.outcome).toEqual(outcome);
    },
  );

  it.each([
    { name: 'invalid JSON', body: Buffer.from('{not json') },
    {
      name: 'a missing endpoint id',
      body: encodeMessage({ ...valid, endpointId: undefined }),
    },
    {
      name: 'an empty event type',
      body: encodeMessage({ ...valid, eventType: '' }),
    },
    { name: 'an empty body', body: Buffer.alloc(0) },
  ])('rejects $name as malformed without attempting', async ({ body }) => {
    await expect(handler.handle(message(body))).rejects.toBeInstanceOf(
      MalformedMessageError,
    );
    expect(delivery.jobs).toHaveLength(0);
  });

  it('lets an error from the attempt through, so the message is not acked', async () => {
    delivery.failWith = new Error('database is down');

    await expect(handler.handle(message(encodeMessage(valid)))).rejects.toThrow(
      'database is down',
    );
  });

  it('does not resolve before the attempt has finished, so the ack waits for it', async () => {
    delivery.hold();
    let resolved = false;
    const handled = handler.handle(message(encodeMessage(valid))).then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivery.jobs).toHaveLength(1);
    expect(resolved).toBe(false);

    delivery.release?.();
    await handled;
    expect(resolved).toBe(true);
  });
});
