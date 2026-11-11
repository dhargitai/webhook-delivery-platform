import type { OutboxEvent } from '@wdp/core';
import {
  ConfirmPublisher,
  decodeMessage,
  eventPublishedSchema,
  type PublishChannel,
  PublishFailedError,
  topologyNames,
} from '@wdp/messaging';
import type { Message, Options } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerEventPublisher } from './broker-event-publisher.js';

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

describe('BrokerEventPublisher', () => {
  let channel: FakeChannel;
  let publisher: BrokerEventPublisher;

  const event: OutboxEvent = {
    eventId: '018f0000-0000-7000-8000-000000000001',
    tenantId: 'tenant-a',
    eventType: 'invoice.paid',
    payload: { invoice: 'INV-42', lines: [1, 2] },
    createdAt: new Date('2026-11-11T10:00:00.000Z'),
  };

  beforeEach(() => {
    channel = new FakeChannel();
    publisher = new BrokerEventPublisher(
      new ConfirmPublisher(channel),
      topologyNames('t'),
    );
  });

  it('publishes to the events exchange with the event routing key', async () => {
    await publisher.publish(event);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      exchange: 't.events',
      routingKey: 'event.published',
    });
  });

  it('uses the event id as both the message id and the correlation id', async () => {
    await publisher.publish(event);

    expect(channel.sent[0]?.options).toMatchObject({
      messageId: event.eventId,
      correlationId: event.eventId,
    });
  });

  it('sends a body that satisfies the EventPublished contract', async () => {
    await publisher.publish(event);

    const body = channel.sent[0]?.content ?? Buffer.alloc(0);
    expect(decodeMessage(body, eventPublishedSchema)).toEqual({
      eventId: event.eventId,
      tenantId: 'tenant-a',
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42', lines: [1, 2] },
      createdAt: '2026-11-11T10:00:00.000Z',
    });
  });

  it('fails when the broker does not confirm', async () => {
    channel.nack = true;

    await expect(publisher.publish(event)).rejects.toBeInstanceOf(
      PublishFailedError,
    );
  });
});
