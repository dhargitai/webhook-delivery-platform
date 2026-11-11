import {
  ConfirmPublisher,
  DISPATCH_ATTEMPT_HEADER,
  DISPATCH_EXHAUSTED,
  FAILURE_KIND_HEADER,
  FAILURE_REASON_HEADER,
  type PublishChannel,
  PublishFailedError,
  topologyNames,
} from '@wdp/messaging';
import type { ConsumeMessage, Message, Options } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerDispatchRetryPublisher } from './broker-dispatch-retry-publisher.js';

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

describe('BrokerDispatchRetryPublisher', () => {
  let channel: FakeChannel;
  let publisher: BrokerDispatchRetryPublisher;
  const names = topologyNames('t');
  const DELAY = 5000;

  const original = {
    content: Buffer.from('{"eventId":"evt-1"}'),
    properties: {
      messageId: 'evt-1',
      correlationId: 'evt-1',
      type: 'event.published',
      headers: { 'x-other': 'kept?' },
    },
  } as unknown as ConsumeMessage;

  beforeEach(() => {
    channel = new FakeChannel();
    publisher = new BrokerDispatchRetryPublisher(
      new ConfirmPublisher(channel),
      names,
      DELAY,
    );
  });

  describe('retry', () => {
    it('puts the event in the retry queue through the default exchange', async () => {
      await publisher.retry(original, 2);

      expect(channel.sent[0]).toMatchObject({
        exchange: '',
        routingKey: names.dispatchRetryQueue(DELAY),
      });
    });

    it('sends the original body with its ids and the new attempt number', async () => {
      await publisher.retry(original, 2);

      expect(channel.sent[0]?.content).toEqual(original.content);
      expect(channel.sent[0]?.options).toMatchObject({
        messageId: 'evt-1',
        correlationId: 'evt-1',
        type: 'event.published',
        headers: { [DISPATCH_ATTEMPT_HEADER]: 2 },
      });
    });

    it('fails when the broker does not confirm', async () => {
      channel.nack = true;

      await expect(publisher.retry(original, 2)).rejects.toBeInstanceOf(
        PublishFailedError,
      );
    });
  });

  describe('deadLetter', () => {
    it('publishes to the dead-letter exchange', async () => {
      await publisher.deadLetter(original, 'postgres is down');

      expect(channel.sent[0]).toMatchObject({
        exchange: names.deadLetterExchange,
        routingKey: '',
      });
    });

    it('keeps the original body and ids and says why it is there', async () => {
      await publisher.deadLetter(original, 'postgres is down');

      expect(channel.sent[0]?.content).toEqual(original.content);
      expect(channel.sent[0]?.options).toMatchObject({
        messageId: 'evt-1',
        correlationId: 'evt-1',
        headers: {
          [FAILURE_KIND_HEADER]: DISPATCH_EXHAUSTED,
          [FAILURE_REASON_HEADER]: 'postgres is down',
        },
      });
    });

    it('fails when the broker does not confirm', async () => {
      channel.nack = true;

      await expect(
        publisher.deadLetter(original, 'postgres is down'),
      ).rejects.toBeInstanceOf(PublishFailedError);
    });
  });
});
