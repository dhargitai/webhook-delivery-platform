import type { Message, Options } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfirmPublisher,
  ConfirmTimeoutError,
  PublishFailedError,
  type PublishChannel,
  UnroutableMessageError,
} from './confirm-publisher.js';

interface Published {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

/**
 * A channel whose broker answers however the test says: ack, nack, return
 * then ack, or not at all.
 */
class FakeChannel implements PublishChannel {
  readonly published: Published[] = [];
  behaviour: 'ack' | 'nack' | 'return-then-ack' | 'silent' | 'throw' = 'ack';
  private returnListener: ((message: Message) => void) | undefined;

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: (err: unknown) => void,
  ): boolean {
    if (this.behaviour === 'throw') {
      throw new Error('channel closed');
    }
    this.published.push({ exchange, routingKey, content, options });
    queueMicrotask(() => {
      switch (this.behaviour) {
        case 'ack':
          callback(null);
          break;
        case 'nack':
          callback(new Error('message nacked'));
          break;
        case 'return-then-ack':
          this.returnListener?.({
            properties: { messageId: options.messageId },
          } as Message);
          callback(null);
          break;
        case 'silent':
        case 'throw':
          break;
      }
    });
    return true;
  }

  on(event: 'return', listener: (message: Message) => void): this {
    this.returnListener = listener;
    return this;
  }
}

describe('ConfirmPublisher', () => {
  let channel: FakeChannel;
  let publisher: ConfirmPublisher;

  beforeEach(() => {
    channel = new FakeChannel();
    publisher = new ConfirmPublisher(channel, { confirmTimeoutMs: 30 });
  });

  const body = Buffer.from('{"a":1}');
  const props = { messageId: 'msg-1', correlationId: 'evt-1' };

  it('resolves once the broker acks', async () => {
    await expect(
      publisher.publish('ex', 'key', body, props),
    ).resolves.toBeUndefined();
  });

  it('publishes a persistent, mandatory JSON message with its ids', async () => {
    await publisher.publish('ex', 'key', body, props);

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]).toMatchObject({
      exchange: 'ex',
      routingKey: 'key',
      content: body,
      options: {
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId: 'msg-1',
        correlationId: 'evt-1',
      },
    });
  });

  it('passes the given headers on to the broker', async () => {
    await publisher.publish('ex', 'key', body, {
      ...props,
      headers: { 'x-attempt': 2, 'x-reason': 'boom' },
    });

    expect(channel.published[0]?.options.headers).toEqual({
      'x-attempt': 2,
      'x-reason': 'boom',
    });
  });

  it('rejects when the broker nacks', async () => {
    channel.behaviour = 'nack';

    await expect(
      publisher.publish('ex', 'key', body, props),
    ).rejects.toBeInstanceOf(PublishFailedError);
  });

  it('rejects when no confirm arrives in time, instead of waiting forever', async () => {
    channel.behaviour = 'silent';

    await expect(
      publisher.publish('ex', 'key', body, props),
    ).rejects.toBeInstanceOf(ConfirmTimeoutError);
  });

  it('rejects a message the broker returned as unroutable, even though it was acked', async () => {
    channel.behaviour = 'return-then-ack';

    await expect(
      publisher.publish('ex', 'key', body, props),
    ).rejects.toBeInstanceOf(UnroutableMessageError);
  });

  it('forgets a returned message, so the next publish with that id can succeed', async () => {
    channel.behaviour = 'return-then-ack';
    await expect(
      publisher.publish('ex', 'key', body, props),
    ).rejects.toBeInstanceOf(UnroutableMessageError);

    channel.behaviour = 'ack';

    await expect(
      publisher.publish('ex', 'key', body, props),
    ).resolves.toBeUndefined();
  });

  it('rejects when the channel throws on publish', async () => {
    channel.behaviour = 'throw';

    await expect(
      publisher.publish('ex', 'key', body, props),
    ).rejects.toBeInstanceOf(PublishFailedError);
  });
});
