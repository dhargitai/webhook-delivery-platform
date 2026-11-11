import type { ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ConfirmPublisher } from './confirm-publisher.js';
import { BrokerConnection } from './connection.js';
import { Consumer, RequeueError } from './consumer.js';
import { EVENT_PUBLISHED_ROUTING_KEY } from './names.js';
import { eventually, testingNamespace } from './testing/helpers.js';
import { declareTopology, DELIVERY_LIMIT } from './topology.js';

describe('Consumer (real RabbitMQ)', () => {
  let conn: BrokerConnection;
  const connectionErrors: Error[] = [];

  beforeAll(async () => {
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      connectionErrors.push(e),
    );
  });

  afterAll(async () => {
    await conn.close();
  });

  async function setUp() {
    const setup = await conn.createChannel();
    const names = await declareTopology(setup, {
      laneCount: 1,
      namespace: testingNamespace(),
    });
    const publisher = new ConfirmPublisher(await conn.createConfirmChannel());
    const send = (body: string, messageId = body) =>
      publisher.publish(
        names.eventsExchange,
        EVENT_PUBLISHED_ROUTING_KEY,
        Buffer.from(body),
        { messageId },
      );
    const depth = async (queue: string) => {
      const probe = await conn.createChannel();
      const { messageCount } = await probe.checkQueue(queue);
      await probe.close();
      return messageCount;
    };
    return { names, send, depth };
  }

  const noop = () => undefined;

  it('acks a message after its handler succeeds', async () => {
    const { names, send, depth } = await setUp();
    const seen: string[] = [];
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async (message) => {
        seen.push(message.content.toString());
      },
      { prefetch: 5, onHandlerError: noop },
    );

    await send('hello');

    await eventually(async () => {
      expect(seen).toEqual(['hello']);
      expect(await depth(names.dispatchQueue)).toBe(0);
    });
  });

  it('dead-letters a message whose handler throws, once, instead of retrying it in a loop', async () => {
    const { names, send, depth } = await setUp();
    let calls = 0;
    const errors: unknown[] = [];
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        calls += 1;
        throw new Error('handler failed');
      },
      { prefetch: 5, onHandlerError: (error) => errors.push(error) },
    );

    await send('poison');

    await eventually(async () => {
      expect(await depth(names.deadLetterQueue)).toBe(1);
    });
    // Give a requeue loop time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);
    expect(await depth(names.dispatchQueue)).toBe(0);
    expect(errors).toHaveLength(1);
    const probe = await conn.createChannel();
    const dead = await probe.get(names.deadLetterQueue, { noAck: true });
    expect(dead !== false && dead.content.toString()).toBe('poison');
  });

  it('redelivers a message whose handler throws RequeueError, without dead-lettering it', async () => {
    const { names, send, depth } = await setUp();
    let calls = 0;
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new RequeueError('broker busy');
        }
      },
      { prefetch: 1, onHandlerError: noop },
    );

    await send('again');

    await eventually(async () => {
      expect(calls).toBe(2);
      expect(await depth(names.dispatchQueue)).toBe(0);
    });
    expect(await depth(names.deadLetterQueue)).toBe(0);
  });

  it('never dead-letters a message that is requeued over and over, past the delivery limit', async () => {
    // Pins RabbitMQ 4.4: a nack with requeue does not count toward the limit.
    const { names, send, depth } = await setUp();
    const requeues = DELIVERY_LIMIT * 3;
    let calls = 0;
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        calls += 1;
        if (calls <= requeues) {
          throw new RequeueError('not yet');
        }
      },
      { prefetch: 1, onHandlerError: noop },
    );

    await send('patient');

    await eventually(async () => {
      expect(calls).toBe(requeues + 1);
      expect(await depth(names.dispatchQueue)).toBe(0);
    });
    expect(await depth(names.deadLetterQueue)).toBe(0);
  });

  it('reports a handler error together with its message', async () => {
    const { names, send } = await setUp();
    const reported: { error: unknown; body: string }[] = [];
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        throw new Error('boom');
      },
      {
        prefetch: 1,
        onHandlerError: (error, message) =>
          reported.push({ error, body: message.content.toString() }),
      },
    );

    await send('x');

    await eventually(() => {
      expect(reported).toHaveLength(1);
    });
    expect(reported[0]).toMatchObject({ body: 'x', error: new Error('boom') });
  });

  it('redelivers a message whose consumer died before acking', async () => {
    const { names, send } = await setUp();
    await send('survivor', 'survivor-id');

    // First consumer receives the message and dies without acking.
    const doomed = await conn.createChannel();
    const received = new Promise<ConsumeMessage>((resolve) => {
      void Consumer.start(
        doomed,
        names.dispatchQueue,
        (message) => {
          resolve(message);
          return new Promise<void>(() => undefined); // never finishes
        },
        { prefetch: 1, onHandlerError: noop },
      );
    });
    const first = await received;
    expect(first.fields.redelivered).toBe(false);
    await doomed.close();

    // A second consumer gets the very same message.
    const second = await conn.createChannel();
    const again = new Promise<ConsumeMessage>((resolve) => {
      void Consumer.start(
        second,
        names.dispatchQueue,
        async (message) => resolve(message),
        { prefetch: 1, onHandlerError: noop },
      );
    });
    const redelivered = await again;

    expect(redelivered.content.toString()).toBe('survivor');
    expect(redelivered.properties.messageId).toBe('survivor-id');
    expect(redelivered.fields.redelivered).toBe(true);
  });

  it('dead-letters a message that keeps killing its consumers, after the delivery limit', async () => {
    const { names, send, depth } = await setUp();
    await send('crash-loop');

    let deliveries = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if ((await depth(names.deadLetterQueue)) === 1) break;
      const channel = await conn.createChannel();
      const got = new Promise<boolean>((resolve) => {
        void Consumer.start(
          channel,
          names.dispatchQueue,
          () => {
            resolve(true);
            return new Promise<void>(() => undefined);
          },
          { prefetch: 1, onHandlerError: noop },
        );
        setTimeout(() => resolve(false), 1_000);
      });
      if (await got) deliveries += 1;
      await channel.close();
    }

    await eventually(async () => {
      expect(await depth(names.deadLetterQueue)).toBe(1);
    });
    expect(await depth(names.dispatchQueue)).toBe(0);
    // The first delivery plus DELIVERY_LIMIT redeliveries, then the DLQ.
    expect(deliveries).toBe(1 + DELIVERY_LIMIT);
  });

  it('never runs more handlers at once than its prefetch', async () => {
    const { names, send } = await setUp();
    let running = 0;
    let peak = 0;
    let done = 0;
    const channel = await conn.createChannel();
    await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 100));
        running -= 1;
        done += 1;
      },
      { prefetch: 2, onHandlerError: noop },
    );

    await Promise.all(Array.from({ length: 6 }, (_, i) => send(`m${i}`)));

    await eventually(() => {
      expect(done).toBe(6);
    });
    expect(peak).toBe(2);
  });

  it('stop() waits for the handler in flight and lets it ack', async () => {
    const { names, send, depth } = await setUp();
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = noop;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const channel = await conn.createChannel();
    const consumer = await Consumer.start(
      channel,
      names.dispatchQueue,
      async () => {
        started();
        await gate;
        finished = true;
      },
      { prefetch: 1, onHandlerError: noop },
    );
    await send('in-flight');
    await handlerStarted;

    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stopped).toBe(false);

    release();
    await stopping;

    expect(finished).toBe(true);
    await channel.close();
    // Acked before the channel closed, so there is nothing to redeliver.
    expect(await depth(names.dispatchQueue)).toBe(0);
  });

  it('takes no new messages after stop()', async () => {
    const { names, send, depth } = await setUp();
    const seen: string[] = [];
    const channel = await conn.createChannel();
    const consumer = await Consumer.start(
      channel,
      names.dispatchQueue,
      async (message) => {
        seen.push(message.content.toString());
      },
      { prefetch: 1, onHandlerError: noop },
    );
    await consumer.stop();

    await send('late');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen).toEqual([]);
    expect(await depth(names.dispatchQueue)).toBe(1);
  });
});
