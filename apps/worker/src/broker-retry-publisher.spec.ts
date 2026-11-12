import { randomUUID } from 'node:crypto';
import { type DeliveryJob, LaneRouter } from '@wdp/core';
import {
  ConfirmPublisher,
  decodeMessage,
  DELIVERY_EXHAUSTED,
  deliveryRequestedSchema,
  FAILURE_KIND_HEADER,
  FAILURE_REASON_HEADER,
  type PublishChannel,
  PublishFailedError,
  topologyNames,
} from '@wdp/messaging';
import type { Message, Options } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerRetryPublisher } from './broker-retry-publisher.js';

interface Sent {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

class FakeChannel implements PublishChannel {
  readonly sent: Sent[] = [];
  nack = false;

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: (err: unknown) => void,
  ): boolean {
    this.sent.push({ exchange, routingKey, content, options });
    queueMicrotask(() =>
      callback(this.nack ? new Error('message nacked') : null),
    );
    return true;
  }

  on(_event: 'return', _listener: (message: Message) => void): this {
    return this;
  }
}

describe('BrokerRetryPublisher', () => {
  let channel: FakeChannel;
  let publisher: BrokerRetryPublisher;
  const names = topologyNames('t');

  const job: DeliveryJob = {
    deliveryId: 'delivery-1',
    eventId: 'event-1',
    tenantId: 'tenant-1',
    endpointId: 'endpoint-1',
    eventType: 'invoice.paid',
    payload: { invoice: 'INV-42' },
    attemptNo: 2,
  };

  const lanes = new LaneRouter(4);

  beforeEach(() => {
    channel = new FakeChannel();
    publisher = new BrokerRetryPublisher(
      new ConfirmPublisher(channel),
      names,
      lanes,
    );
  });

  it('puts the job in the retry tier queue of its delay, through the default exchange', async () => {
    await publisher.retry(job, 30_000);

    expect(channel.sent[0]).toMatchObject({
      exchange: '',
      routingKey: names.retryTierQueue(30_000),
    });
  });

  it('picks the queue by the delay it is given', async () => {
    await publisher.retry(job, 4_000);
    await publisher.retry(job, 6_000);

    expect(channel.sent.map((sent) => sent.routingKey)).toEqual([
      names.retryTierQueue(4_000),
      names.retryTierQueue(6_000),
    ]);
  });

  it('sends a job that decodes to the one it was given, attempt number included', async () => {
    await publisher.retry(job, 5_000);

    const body = channel.sent[0]?.content;
    expect(body && decodeMessage(body, deliveryRequestedSchema)).toEqual(job);
  });

  it('keeps the delivery id as the message id and the event id as the correlation id', async () => {
    await publisher.retry(job, 5_000);

    expect(channel.sent[0]?.options).toMatchObject({
      messageId: 'delivery-1',
      correlationId: 'event-1',
      type: 'delivery.requested',
    });
  });

  it('fails when the broker does not confirm', async () => {
    channel.nack = true;

    await expect(publisher.retry(job, 5_000)).rejects.toBeInstanceOf(
      PublishFailedError,
    );
  });

  describe('deadLetter', () => {
    it('sends the job to the dead-letter exchange', async () => {
      await publisher.deadLetter(job, 'http_error: HTTP 503');

      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]).toMatchObject({
        exchange: names.deadLetterExchange,
        routingKey: '',
      });
    });

    it('sends a job that decodes to the one it was given, attempt number included', async () => {
      await publisher.deadLetter(job, 'http_error: HTTP 503');

      const body = channel.sent[0]?.content;
      expect(body && decodeMessage(body, deliveryRequestedSchema)).toEqual(job);
    });

    it('marks the entry as an exhausted delivery, with the reason', async () => {
      await publisher.deadLetter(job, 'http_error: HTTP 503');

      expect(channel.sent[0]?.options).toMatchObject({
        messageId: 'delivery-1',
        correlationId: 'event-1',
        type: 'delivery.requested',
        headers: {
          [FAILURE_KIND_HEADER]: DELIVERY_EXHAUSTED,
          [FAILURE_REASON_HEADER]: 'http_error: HTTP 503',
        },
      });
    });

    it('fails when the broker does not confirm', async () => {
      channel.nack = true;

      await expect(
        publisher.deadLetter(job, 'http_error: HTTP 503'),
      ).rejects.toBeInstanceOf(PublishFailedError);
    });
  });

  describe('park', () => {
    it('puts the job in the delay queue of its own lane, through the default exchange', async () => {
      await publisher.park(job, 5_000);

      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]).toMatchObject({
        exchange: '',
        routingKey: names.parkQueue(5_000, lanes.lane(job.endpointId)),
      });
    });

    it('picks the lane by the endpoint, so the job returns to the lane it came from', async () => {
      const endpointIds = Array.from({ length: 50 }, () => randomUUID());

      for (const endpointId of endpointIds) {
        await publisher.park({ ...job, endpointId }, 5_000);
      }

      const queues = channel.sent.map((sent) => sent.routingKey);
      expect(queues).toEqual(
        endpointIds.map((id) => names.parkQueue(5_000, lanes.lane(id))),
      );
      // The endpoints spread over the lanes, so a fixed lane would be caught.
      expect(new Set(queues).size).toBeGreaterThan(1);
    });

    it('picks the queue by the delay it is given', async () => {
      await publisher.park(job, 500);

      expect(channel.sent[0]?.routingKey).toBe(
        names.parkQueue(500, lanes.lane(job.endpointId)),
      );
    });

    it('sends the job as it was, attempt number included, under its delivery id', async () => {
      await publisher.park(job, 5_000);

      const body = channel.sent[0]?.content;
      expect(body && decodeMessage(body, deliveryRequestedSchema)).toEqual(job);
      expect(channel.sent[0]?.options).toMatchObject({
        messageId: 'delivery-1',
        correlationId: 'event-1',
        type: 'delivery.requested',
      });
    });

    it('fails when the broker does not confirm', async () => {
      channel.nack = true;

      await expect(publisher.park(job, 5_000)).rejects.toBeInstanceOf(
        PublishFailedError,
      );
    });
  });
});
