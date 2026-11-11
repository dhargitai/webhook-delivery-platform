import { laneRoutingKey } from '@wdp/domain';
import type { GetMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BrokerConnection } from './connection.js';
import { EVENT_PUBLISHED_ROUTING_KEY } from './names.js';
import { eventually, testingNamespace } from './testing/helpers.js';
import {
  declareDispatchRetryTopology,
  declareEventTopology,
  declareTopology,
} from './topology.js';

describe('declareTopology (real RabbitMQ)', () => {
  let conn: BrokerConnection;
  const channelErrors: Error[] = [];

  beforeAll(async () => {
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (error) =>
      channelErrors.push(error),
    );
  });

  afterAll(async () => {
    await conn.close();
  });

  /** Publishes on a confirm channel and waits until the broker has the message. */
  async function publishConfirmed(
    exchange: string,
    routingKey: string,
    body: string,
  ) {
    const channel = await conn.createConfirmChannel();
    channel.publish(exchange, routingKey, Buffer.from(body), {
      persistent: true,
    });
    await channel.waitForConfirms();
    await channel.close();
  }

  async function take(queue: string): Promise<string | null> {
    const channel = await conn.createChannel();
    const message = await channel.get(queue, { noAck: true });
    await channel.close();
    return message === false ? null : message.content.toString();
  }

  it('can be declared twice without error', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();

    await declareTopology(channel, { laneCount: 2, namespace });

    await expect(
      declareTopology(channel, { laneCount: 2, namespace }),
    ).resolves.toBeDefined();
  });

  it('makes quorum queues with the delivery limit and dead-letter exchange', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();
    const names = await declareTopology(channel, { laneCount: 1, namespace });

    // RabbitMQ refuses to redeclare a queue with different arguments, which
    // lets us check them without the management API.
    const same = await conn.createChannel();
    await expect(
      same.assertQueue(names.dispatchQueue, {
        durable: true,
        // Spelled out, not built by the code under test, so a change to the
        // real arguments cannot pass unnoticed.
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': 5,
          'x-dead-letter-exchange': names.deadLetterExchange,
        },
      }),
    ).resolves.toBeDefined();

    const differentLimit = await conn.createChannel();
    await expect(
      differentLimit.assertQueue(names.dispatchQueue, {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': 6,
          'x-dead-letter-exchange': names.deadLetterExchange,
        },
      }),
    ).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('delivers an event published to the events exchange to the dispatch queue', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();
    const names = await declareTopology(channel, { laneCount: 1, namespace });

    await publishConfirmed(
      names.eventsExchange,
      EVENT_PUBLISHED_ROUTING_KEY,
      'event-body',
    );

    expect(await take(names.dispatchQueue)).toBe('event-body');
  });

  it('delivers a delivery job to the lane named by its routing key and to no other', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();
    const names = await declareTopology(channel, { laneCount: 3, namespace });

    await publishConfirmed(names.deliveriesExchange, laneRoutingKey(1), 'job');

    expect(await take(names.laneQueue(0))).toBeNull();
    expect(await take(names.laneQueue(2))).toBeNull();
    expect(await take(names.laneQueue(1))).toBe('job');
  });

  it('declares only the events side when asked to, so a service need not know the lane count', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();

    const names = await declareEventTopology(channel, { namespace });

    const probe = await conn.createChannel();
    await expect(probe.checkQueue(names.dispatchQueue)).resolves.toBeDefined();
    const dlq = await conn.createChannel();
    await expect(dlq.checkQueue(names.deadLetterQueue)).resolves.toBeDefined();
    const lane = await conn.createChannel();
    await expect(lane.checkQueue(names.laneQueue(0))).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('is compatible with the full declaration made before or after it', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();

    await declareEventTopology(channel, { namespace });
    await expect(
      declareTopology(channel, { laneCount: 2, namespace }),
    ).resolves.toBeDefined();
    await expect(
      declareEventTopology(channel, { namespace }),
    ).resolves.toBeDefined();
  });

  it('declares exactly one queue per lane', async () => {
    const namespace = testingNamespace();
    const channel = await conn.createChannel();
    const names = await declareTopology(channel, { laneCount: 3, namespace });

    for (const lane of [0, 1, 2]) {
      const probe = await conn.createChannel();
      await expect(
        probe.checkQueue(names.laneQueue(lane)),
      ).resolves.toBeDefined();
    }
    const missing = await conn.createChannel();
    await expect(missing.checkQueue(names.laneQueue(3))).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  describe('the dispatch retry queue', () => {
    it('hands a parked event back to the dispatch queue after its delay, unchanged', async () => {
      const namespace = testingNamespace();
      const channel = await conn.createChannel();
      const names = await declareEventTopology(channel, { namespace });
      const delayMs = 300;
      await declareDispatchRetryTopology(channel, { namespace, delayMs });

      const publisher = await conn.createConfirmChannel();
      const parkedAt = Date.now();
      publisher.publish(
        '',
        names.dispatchRetryQueue(delayMs),
        Buffer.from('parked'),
        {
          persistent: true,
          messageId: 'evt-1',
          headers: { 'x-dispatch-attempt': 2 },
        },
      );
      await publisher.waitForConfirms();

      const consumer = await conn.createChannel();
      expect(await consumer.get(names.dispatchQueue, { noAck: true })).toBe(
        false,
      );
      let message: GetMessage | undefined;
      await eventually(async () => {
        const got = await consumer.get(names.dispatchQueue, { noAck: true });
        expect(got).not.toBe(false);
        message = got === false ? undefined : got;
      });
      const waited = Date.now() - parkedAt;

      expect(waited).toBeGreaterThanOrEqual(delayMs - 50);
      expect(message?.content.toString()).toBe('parked');
      expect(message?.properties.messageId).toBe('evt-1');
      expect(message?.properties.headers?.['x-dispatch-attempt']).toBe(2);
    });

    it('names the queue after its delay, so a changed delay makes a new queue instead of failing', async () => {
      const namespace = testingNamespace();
      const channel = await conn.createChannel();
      const names = await declareEventTopology(channel, { namespace });

      await declareDispatchRetryTopology(channel, { namespace, delayMs: 5000 });
      await expect(
        declareDispatchRetryTopology(channel, { namespace, delayMs: 7000 }),
      ).resolves.toBeDefined();

      expect(names.dispatchRetryQueue(5000)).not.toBe(
        names.dispatchRetryQueue(7000),
      );
      const probe = await conn.createChannel();
      await expect(
        probe.checkQueue(names.dispatchRetryQueue(5000)),
      ).resolves.toBeDefined();
      const probe2 = await conn.createChannel();
      await expect(
        probe2.checkQueue(names.dispatchRetryQueue(7000)),
      ).resolves.toBeDefined();
    });

    it('is not declared by the events side alone, so the relay never creates it', async () => {
      const namespace = testingNamespace();
      const channel = await conn.createChannel();
      const names = await declareEventTopology(channel, { namespace });

      const probe = await conn.createChannel();
      await expect(
        probe.checkQueue(names.dispatchRetryQueue(5000)),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'rejects a delay of %s',
      async (delayMs) => {
        const channel = await conn.createChannel();

        await expect(
          declareDispatchRetryTopology(channel, {
            namespace: testingNamespace(),
            delayMs,
          }),
        ).rejects.toThrow(RangeError);
      },
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a lane count of %s',
    async (laneCount) => {
      const channel = await conn.createChannel();

      await expect(
        declareTopology(channel, { laneCount, namespace: testingNamespace() }),
      ).rejects.toThrow(RangeError);
    },
  );
});
