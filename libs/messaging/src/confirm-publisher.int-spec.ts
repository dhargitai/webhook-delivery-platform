import { laneRoutingKey } from '@wdp/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ConfirmPublisher,
  PublishFailedError,
  UnroutableMessageError,
} from './confirm-publisher.js';
import { BrokerConnection } from './connection.js';
import { EVENT_PUBLISHED_ROUTING_KEY } from './names.js';
import { testingNamespace } from './testing/helpers.js';
import { declareTopology } from './topology.js';

describe('ConfirmPublisher (real RabbitMQ)', () => {
  let conn: BrokerConnection;
  const errors: Error[] = [];

  beforeAll(async () => {
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      errors.push(e),
    );
  });

  afterAll(async () => {
    await conn.close();
  });

  async function setUp() {
    const namespace = testingNamespace();
    const setup = await conn.createChannel();
    const names = await declareTopology(setup, { laneCount: 2, namespace });
    const channel = await conn.createConfirmChannel();
    return { names, channel, publisher: new ConfirmPublisher(channel) };
  }

  async function get(queue: string) {
    const channel = await conn.createChannel();
    const message = await channel.get(queue, { noAck: true });
    await channel.close();
    return message === false ? null : message;
  }

  it('stores the message with its body, ids and persistence', async () => {
    const { names, publisher } = await setUp();

    await publisher.publish(
      names.eventsExchange,
      EVENT_PUBLISHED_ROUTING_KEY,
      Buffer.from('{"hello":"world"}'),
      { messageId: 'evt-1', correlationId: 'evt-1' },
    );

    const message = await get(names.dispatchQueue);
    expect(message?.content.toString()).toBe('{"hello":"world"}');
    expect(message?.properties).toMatchObject({
      messageId: 'evt-1',
      correlationId: 'evt-1',
      contentType: 'application/json',
      deliveryMode: 2,
    });
  });

  it('rejects a message no queue accepts, and stores nothing', async () => {
    const { names, publisher } = await setUp();

    await expect(
      publisher.publish(
        names.deliveriesExchange,
        'no.such.route',
        Buffer.from('lost'),
        { messageId: 'm-1' },
      ),
    ).rejects.toBeInstanceOf(UnroutableMessageError);

    expect(await get(names.laneQueue(0))).toBeNull();
    expect(await get(names.laneQueue(1))).toBeNull();
  });

  it('rejects publishing to an exchange that does not exist', async () => {
    const { publisher } = await setUp();

    await expect(
      publisher.publish('missing.exchange', 'k', Buffer.from('x'), {
        messageId: 'm-1',
      }),
    ).rejects.toBeInstanceOf(PublishFailedError);
  });

  it('keeps working after an unroutable message', async () => {
    const { names, publisher } = await setUp();
    await expect(
      publisher.publish(
        names.deliveriesExchange,
        'no.such.route',
        Buffer.from('x'),
        {
          messageId: 'same-id',
        },
      ),
    ).rejects.toBeInstanceOf(UnroutableMessageError);

    await publisher.publish(
      names.deliveriesExchange,
      laneRoutingKey(0),
      Buffer.from('ok'),
      { messageId: 'same-id' },
    );

    expect((await get(names.laneQueue(0)))?.content.toString()).toBe('ok');
  });

  it('rejects once its channel is closed', async () => {
    const { names, channel, publisher } = await setUp();
    await channel.close();

    await expect(
      publisher.publish(
        names.eventsExchange,
        EVENT_PUBLISHED_ROUTING_KEY,
        Buffer.from('x'),
        { messageId: 'm-1' },
      ),
    ).rejects.toBeInstanceOf(PublishFailedError);
  });

  it('confirms many concurrent publishes', async () => {
    const { names, publisher } = await setUp();

    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        publisher.publish(
          names.eventsExchange,
          EVENT_PUBLISHED_ROUTING_KEY,
          Buffer.from(`m${i}`),
          { messageId: `m${i}` },
        ),
      ),
    );

    const probe = await conn.createChannel();
    expect((await probe.checkQueue(names.dispatchQueue)).messageCount).toBe(
      200,
    );
  });
});
