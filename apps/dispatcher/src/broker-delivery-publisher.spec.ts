import type { DeliveryJob } from '@wdp/core';
import {
  ConfirmPublisher,
  decodeMessage,
  deliveryRequestedSchema,
  type PublishChannel,
  PublishFailedError,
  topologyNames,
} from '@wdp/messaging';
import type { Message, Options } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerDeliveryPublisher } from './broker-delivery-publisher.js';

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

describe('BrokerDeliveryPublisher', () => {
  let channel: FakeChannel;
  let publisher: BrokerDeliveryPublisher;

  const job: DeliveryJob = {
    deliveryId: 'd'.repeat(64),
    eventId: '018f0000-0000-7000-8000-000000000001',
    tenantId: 'tenant-a',
    endpointId: 'endpoint-1',
    eventType: 'invoice.paid',
    payload: { invoice: 'INV-42' },
  };

  beforeEach(() => {
    channel = new FakeChannel();
    publisher = new BrokerDeliveryPublisher(
      new ConfirmPublisher(channel),
      topologyNames('t'),
    );
  });

  it('publishes to the deliveries exchange with the given lane routing key', async () => {
    await publisher.publish(job, 'fresh.shard.02');

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      exchange: 't.deliveries',
      routingKey: 'fresh.shard.02',
    });
  });

  it('uses the delivery id as message id and the event id as correlation id', async () => {
    await publisher.publish(job, 'fresh.shard.00');

    expect(channel.sent[0]?.options).toMatchObject({
      messageId: job.deliveryId,
      correlationId: job.eventId,
      type: 'delivery.requested',
    });
  });

  it('sends a body that satisfies the DeliveryRequested contract', async () => {
    await publisher.publish(job, 'fresh.shard.00');

    const body = channel.sent[0]?.content ?? Buffer.alloc(0);
    expect(decodeMessage(body, deliveryRequestedSchema)).toEqual(job);
  });

  it('fails when the broker does not confirm', async () => {
    channel.nack = true;

    await expect(
      publisher.publish(job, 'fresh.shard.00'),
    ).rejects.toBeInstanceOf(PublishFailedError);
  });
});
