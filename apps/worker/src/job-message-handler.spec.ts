import {
  type AttemptOutcome,
  type AttemptRecord,
  AttemptLog,
  type DeliveryJob,
} from '@wdp/core';
import { FakeAttemptLog } from '@wdp/core/testing';
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

  /** Runs while the attempt is in progress, e.g. to let time pass. */
  during?: () => void;

  async attempt(job: DeliveryJob): Promise<AttemptOutcome> {
    this.jobs.push(job);
    this.during?.();
    await this.gate;
    if (this.failWith) throw this.failWith;
    return this.outcome;
  }
}

/** A log whose write stays pending until released, like a slow database. */
class SlowAttemptLog extends AttemptLog {
  readonly records: AttemptRecord[] = [];
  release?: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async record(record: AttemptRecord): Promise<void> {
    await this.gate;
    this.records.push(record);
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
  let log: FakeAttemptLog;
  let clock: Date;
  let handler: JobMessageHandler;

  beforeEach(() => {
    delivery = new FakeAttempt();
    log = new FakeAttemptLog();
    clock = new Date('2026-11-11T12:00:00.500Z');
    handler = new JobMessageHandler(delivery, log, () => clock);
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

  describe('the attempt log', () => {
    it('records a delivered attempt with the job’s ids and the outcome', async () => {
      delivery.outcome = {
        kind: 'delivered',
        status: 204,
        latencyMs: 31,
        snippet: 'ok',
      };

      await handler.handle(message(encodeMessage(valid)));

      expect(log.records).toEqual([
        {
          tenantId: 'tenant-1',
          endpointId: 'endpoint-1',
          eventId: 'event-1',
          deliveryId: 'delivery-1',
          attemptNo: 1,
          ts: clock,
          status: 'success',
          httpStatus: 204,
          latencyMs: 31,
          responseSnippet: 'ok',
        },
      ]);
    });

    it('records a failed attempt as a failure with its error', async () => {
      delivery.outcome = {
        kind: 'failed',
        failure: 'timeout',
        error: 'no answer',
        latencyMs: 10_000,
      };

      await handler.handle(message(encodeMessage(valid)));

      expect(log.records).toHaveLength(1);
      expect(log.records[0]).toMatchObject({
        status: 'failure',
        error: 'timeout: no answer',
        latencyMs: 10_000,
      });
    });

    it.each<AttemptOutcome>([
      { kind: 'skipped', reason: 'endpoint_missing' },
      { kind: 'skipped', reason: 'endpoint_disabled' },
    ])(
      'records nothing for a skipped attempt ($reason): none was made',
      async (outcome) => {
        delivery.outcome = outcome;

        await handler.handle(message(encodeMessage(valid)));

        expect(log.records).toEqual([]);
      },
    );

    it('takes the attempt number from the job', async () => {
      await handler.handle(message(encodeMessage({ ...valid, attemptNo: 3 })));

      expect(log.records[0]?.attemptNo).toBe(3);
    });

    it('stamps the time the attempt started, not the time it ended', async () => {
      const started = clock;
      delivery.during = () => {
        clock = new Date(started.getTime() + 10_000);
      };

      await handler.handle(message(encodeMessage(valid)));

      expect(log.records[0]?.ts).toEqual(started);
    });

    it('rejects when the log cannot be written, so the message is not acked', async () => {
      log.failWith = new Error('mongo is down');

      await expect(
        handler.handle(message(encodeMessage(valid))),
      ).rejects.toThrow('mongo is down');
    });

    it('records nothing when the attempt itself throws', async () => {
      delivery.failWith = new Error('database is down');

      await expect(
        handler.handle(message(encodeMessage(valid))),
      ).rejects.toThrow('database is down');
      expect(log.records).toEqual([]);
    });

    it('does not record a message it cannot decode', async () => {
      await expect(
        handler.handle(message(Buffer.from('{not json'))),
      ).rejects.toBeInstanceOf(MalformedMessageError);
      expect(log.records).toEqual([]);
    });

    it('does not resolve before the log write has finished, so the ack waits for it', async () => {
      const slow = new SlowAttemptLog();
      const slowHandler = new JobMessageHandler(delivery, slow, () => clock);
      let resolved = false;
      const handled = slowHandler
        .handle(message(encodeMessage(valid)))
        .then((r) => {
          resolved = true;
          return r;
        });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(delivery.jobs).toHaveLength(1);
      expect(resolved).toBe(false);

      slow.release?.();
      await handled;
      expect(resolved).toBe(true);
      expect(slow.records).toHaveLength(1);
    });
  });
});
