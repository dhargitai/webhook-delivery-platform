import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  DeliveryPublisher,
  Dispatcher,
  generateEndpointSecret,
  KyselySubscriptionLookup,
  LaneRouter,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { deliveryId } from '@wdp/domain';
import {
  BrokerConnection,
  ConfirmPublisher,
  Consumer,
  declareDispatchRetryTopology,
  declareTopology,
  decodeMessage,
  deliveryRequestedSchema,
  DISPATCH_EXHAUSTED,
  encodeMessage,
  EVENT_PUBLISHED_ROUTING_KEY,
  FAILURE_KIND_HEADER,
  FAILURE_REASON_HEADER,
  MalformedMessageError,
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BrokerDeliveryPublisher } from './broker-delivery-publisher.js';
import { BrokerDispatchRetryPublisher } from './broker-dispatch-retry-publisher.js';
import { DispatchFailureHandler } from './dispatch-failure-handler.js';
import { EventMessageHandler } from './event-message-handler.js';

const LANES = 4;
const RETRY_DELAY_MS = 200;
const MAX_ATTEMPTS = 3;

class RefusingPublisher extends DeliveryPublisher {
  async publish(_job: DeliveryJob): Promise<void> {
    throw new Error('broker refused the job');
  }
}

/**
 * Fails the publishes `shouldFail` says to, and passes the rest on to the real
 * publisher. Records when each publish was tried.
 */
class FlakyPublisher extends DeliveryPublisher {
  readonly attempts: { endpointId: string; at: number }[] = [];

  constructor(
    private readonly real: DeliveryPublisher,
    private readonly shouldFail: (
      job: DeliveryJob,
      attemptsSoFar: number,
    ) => boolean,
  ) {
    super();
  }

  async publish(job: DeliveryJob, routingKey: string): Promise<void> {
    const before = this.attempts.length;
    this.attempts.push({ endpointId: job.endpointId, at: Date.now() });
    if (this.shouldFail(job, before)) {
      throw new Error('broker confirm timed out');
    }
    await this.real.publish(job, routingKey);
  }
}

describe('dispatcher (real Postgres and RabbitMQ)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  const brokerErrors: Error[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      brokerErrors.push(e),
    );
  });

  afterAll(async () => {
    await conn.close();
    await db.destroy();
    await testDb.drop();
  });

  async function createTenant(): Promise<string> {
    const row = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function addEndpoint(
    tenantId: string,
    eventTypes: string[],
  ): Promise<string> {
    const endpoint = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url: 'https://hooks.acme.test/in',
        signing_secret: generateEndpointSecret(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('subscriptions')
      .values(
        eventTypes.map((event_type) => ({
          tenant_id: tenantId,
          endpoint_id: endpoint.id,
          event_type,
        })),
      )
      .execute();
    return endpoint.id;
  }

  const router = new LaneRouter(LANES);
  const laneOf = (endpointId: string) =>
    Number(router.routingKey(endpointId).split('.').at(-1));

  interface Setup {
    names: TopologyNames;
    handlerErrors: unknown[];
    /** Starts consuming the dispatch queue; returns a way to stop it. */
    startConsumer(): Promise<Consumer>;
    sendEvent(event: Record<string, unknown>): Promise<void>;
    sendRaw(body: Buffer, messageId: string): Promise<void>;
    /** Every job currently on the lane queues, with the lane it sits on. */
    lanes(): Promise<{ lane: number; messageId: string; body: unknown }[]>;
    count(queue: string): Promise<number>;
    dead(): Promise<Buffer[]>;
    /** Like `dead()`, but with the headers the dispatcher left on each message. */
    deadWithHeaders(): Promise<
      { body: unknown; headers: Record<string, unknown> }[]
    >;
  }

  async function setUp({
    refuseJobs = false,
    flaky,
  }: {
    refuseJobs?: boolean;
    /** Wraps the real publisher, to fail some publishes. */
    flaky?: (real: DeliveryPublisher) => DeliveryPublisher;
  } = {}): Promise<Setup> {
    const namespace = testingNamespace();
    const setupChannel = await conn.createChannel();
    const names = await declareTopology(setupChannel, {
      laneCount: LANES,
      namespace,
    });
    await declareDispatchRetryTopology(setupChannel, {
      delayMs: RETRY_DELAY_MS,
      namespace,
    });
    const deliveries = new ConfirmPublisher(await conn.createConfirmChannel());
    const events = new ConfirmPublisher(await conn.createConfirmChannel());
    const handler = new DispatchFailureHandler(
      new EventMessageHandler(
        new Dispatcher(
          new KyselySubscriptionLookup(db),
          refuseJobs
            ? new RefusingPublisher()
            : (flaky ?? ((real) => real))(
                new BrokerDeliveryPublisher(deliveries, names),
              ),
          router,
        ),
      ),
      new BrokerDispatchRetryPublisher(deliveries, names, RETRY_DELAY_MS),
      {
        maxAttempts: MAX_ATTEMPTS,
        onRetryScheduled: () => undefined,
        onExhausted: () => undefined,
      },
    );
    const handlerErrors: unknown[] = [];

    const read = async (queue: string) => {
      const channel = await conn.createChannel();
      const messages = [];
      for (;;) {
        const message = await channel.get(queue, { noAck: true });
        if (message === false) break;
        messages.push(message);
      }
      await channel.close();
      return messages;
    };

    return {
      names,
      handlerErrors,
      async startConsumer() {
        return Consumer.start(
          await conn.createChannel(),
          names.dispatchQueue,
          async (message) => {
            await handler.handle(message);
          },
          {
            prefetch: 5,
            onHandlerError: (error) => handlerErrors.push(error),
          },
        );
      },
      sendEvent: (event) =>
        events.publish(
          names.eventsExchange,
          EVENT_PUBLISHED_ROUTING_KEY,
          encodeMessage(event),
          { messageId: String(event.eventId) },
        ),
      sendRaw: (body, messageId) =>
        events.publish(
          names.eventsExchange,
          EVENT_PUBLISHED_ROUTING_KEY,
          body,
          {
            messageId,
          },
        ),
      async lanes() {
        const found = [];
        for (let lane = 0; lane < LANES; lane++) {
          for (const message of await read(names.laneQueue(lane))) {
            found.push({
              lane,
              messageId: String(message.properties.messageId),
              body: decodeMessage(message.content, deliveryRequestedSchema),
            });
          }
        }
        return found;
      },
      async count(queue) {
        const channel = await conn.createChannel();
        const { messageCount } = await channel.checkQueue(queue);
        await channel.close();
        return messageCount;
      },
      async dead() {
        return (await read(names.deadLetterQueue)).map((m) => m.content);
      },
      async deadWithHeaders() {
        return (await read(names.deadLetterQueue)).map((m) => ({
          body: JSON.parse(m.content.toString()) as unknown,
          headers: m.properties.headers ?? {},
        }));
      },
    };
  }

  const eventFor = (tenantId: string, type = 'invoice.paid') => ({
    eventId: randomUUID(),
    tenantId,
    eventType: type,
    payload: { invoice: 'INV-42' },
    createdAt: new Date().toISOString(),
  });

  /** Waits until `count` jobs are on the lanes, returning them. */
  async function jobsOnLanes(setup: Setup, count: number) {
    const collected: Awaited<ReturnType<Setup['lanes']>> = [];
    await eventually(async () => {
      collected.push(...(await setup.lanes()));
      expect(collected).toHaveLength(count);
    });
    return collected;
  }

  it('turns one event into one job per subscribed endpoint, each on its own lane', async () => {
    const tenantId = await createTenant();
    const endpoints = [
      await addEndpoint(tenantId, ['invoice.paid']),
      await addEndpoint(tenantId, ['invoice.paid', 'invoice.failed']),
      await addEndpoint(tenantId, ['invoice.paid']),
    ];
    await addEndpoint(tenantId, ['card.moved']);
    const setup = await setUp();
    await setup.startConsumer();
    const event = eventFor(tenantId);

    await setup.sendEvent(event);

    const jobs = await jobsOnLanes(setup, 3);
    expect(jobs.map((j) => j.messageId).sort()).toEqual(
      endpoints.map((id) => deliveryId(event.eventId, id)).sort(),
    );
    for (const job of jobs) {
      const body = job.body as DeliveryJob;
      expect(job.lane).toBe(laneOf(body.endpointId));
      expect(body).toMatchObject({
        eventId: event.eventId,
        tenantId,
        eventType: 'invoice.paid',
        payload: { invoice: 'INV-42' },
      });
      expect(body.deliveryId).toBe(job.messageId);
    }
    await eventually(async () => {
      expect(await setup.count(setup.names.dispatchQueue)).toBe(0);
    });
  });

  it('acks an event nobody subscribes to and produces nothing', async () => {
    const tenantId = await createTenant();
    const setup = await setUp();
    await setup.startConsumer();

    await setup.sendEvent(eventFor(tenantId));

    await eventually(async () => {
      expect(await setup.count(setup.names.dispatchQueue)).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await setup.lanes()).toEqual([]);
    expect(await setup.dead()).toEqual([]);
    expect(setup.handlerErrors).toEqual([]);
  });

  it('never gives one tenant’s event to another tenant’s endpoints', async () => {
    const mine = await createTenant();
    const theirs = await createTenant();
    const own = await addEndpoint(mine, ['invoice.paid']);
    await addEndpoint(theirs, ['invoice.paid']);
    const setup = await setUp();
    await setup.startConsumer();

    await setup.sendEvent(eventFor(mine));

    const jobs = await jobsOnLanes(setup, 1);
    expect(jobs[0]?.body).toMatchObject({ endpointId: own });
  });

  it('gives the same job ids when the same event arrives twice, as after a relay duplicate', async () => {
    const tenantId = await createTenant();
    await addEndpoint(tenantId, ['invoice.paid']);
    await addEndpoint(tenantId, ['invoice.paid']);
    const setup = await setUp();
    await setup.startConsumer();
    const event = eventFor(tenantId);

    await setup.sendEvent(event);
    await setup.sendEvent(event);

    const jobs = await jobsOnLanes(setup, 4);
    expect(new Set(jobs.map((j) => j.messageId)).size).toBe(2);
  });

  it('includes endpoints registered after the event was accepted but before it was dispatched', async () => {
    const tenantId = await createTenant();
    const setup = await setUp();
    // The event waits on the queue: nothing is consuming yet.
    await setup.sendEvent(eventFor(tenantId));
    const late = await addEndpoint(tenantId, ['invoice.paid']);

    await setup.startConsumer();

    const jobs = await jobsOnLanes(setup, 1);
    expect(jobs[0]?.body).toMatchObject({ endpointId: late });
  });

  it('dispatches an event to every endpoint after a transient publish failure, without manual action', async () => {
    const tenantId = await createTenant();
    const endpoints = [
      await addEndpoint(tenantId, ['invoice.paid']),
      await addEndpoint(tenantId, ['invoice.paid']),
    ];
    let flakyPublisher: FlakyPublisher | undefined;
    const setup = await setUp({
      // Every publish of the first pass fails once, as in a confirm timeout.
      flaky: (real) =>
        (flakyPublisher = new FlakyPublisher(
          real,
          (_job, attemptsSoFar) => attemptsSoFar < 2,
        )),
    });
    await setup.startConsumer();
    const event = eventFor(tenantId);

    await setup.sendEvent(event);

    const jobs = await jobsOnLanes(setup, 2);
    expect(jobs.map((j) => j.messageId).sort()).toEqual(
      endpoints.map((id) => deliveryId(event.eventId, id)).sort(),
    );
    expect(flakyPublisher?.attempts.length).toBeGreaterThan(2);
    expect(await setup.count(setup.names.deadLetterQueue)).toBe(0);
  });

  it('sends the already sent jobs again under the same ids and adds none, after a partial failure', async () => {
    const tenantId = await createTenant();
    const healthy = await addEndpoint(tenantId, ['invoice.paid']);
    const unlucky = await addEndpoint(tenantId, ['invoice.paid']);
    let unluckyFailed = false;
    const setup = await setUp({
      // The unlucky endpoint's job fails on the first pass only.
      flaky: (real) =>
        new FlakyPublisher(real, (job) => {
          const fail = job.endpointId === unlucky && !unluckyFailed;
          unluckyFailed ||= fail;
          return fail;
        }),
    });
    await setup.startConsumer();
    const event = eventFor(tenantId);

    await setup.sendEvent(event);

    // First pass: the healthy job. Second pass: both jobs, the healthy one again.
    const jobs = await jobsOnLanes(setup, 3);
    const healthyId = deliveryId(event.eventId, healthy);
    const unluckyId = deliveryId(event.eventId, unlucky);
    expect(jobs.map((j) => j.messageId).sort()).toEqual(
      [healthyId, healthyId, unluckyId].sort(),
    );
    expect(await setup.count(setup.names.deadLetterQueue)).toBe(0);
  });

  it('waits the retry delay between attempts instead of spinning on a failing event', async () => {
    const tenantId = await createTenant();
    await addEndpoint(tenantId, ['invoice.paid']);
    let flakyPublisher: FlakyPublisher | undefined;
    const setup = await setUp({
      flaky: (real) => (flakyPublisher = new FlakyPublisher(real, () => true)),
    });
    await setup.startConsumer();

    await setup.sendEvent(eventFor(tenantId));

    await eventually(async () => {
      expect(await setup.count(setup.names.deadLetterQueue)).toBe(1);
    });
    const times = flakyPublisher?.attempts.map((a) => a.at) ?? [];
    expect(times).toHaveLength(MAX_ATTEMPTS);
    for (let i = 1; i < times.length; i++) {
      // A little slack for timer granularity, none for a missing pause.
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        RETRY_DELAY_MS - 50,
      );
    }
  });

  it('dead-letters an event whose dispatch keeps failing, once, with the reason and the original body', async () => {
    const tenantId = await createTenant();
    await addEndpoint(tenantId, ['invoice.paid']);
    const setup = await setUp({ refuseJobs: true });
    await setup.startConsumer();
    const event = eventFor(tenantId);

    await setup.sendEvent(event);

    await eventually(async () => {
      expect(await setup.count(setup.names.deadLetterQueue)).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2));
    expect(await setup.count(setup.names.dispatchQueue)).toBe(0);
    expect(await setup.lanes()).toEqual([]);
    const dead = await setup.deadWithHeaders();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.body).toMatchObject({ eventId: event.eventId });
    expect(dead[0]?.headers).toMatchObject({
      [FAILURE_KIND_HEADER]: DISPATCH_EXHAUSTED,
      [FAILURE_REASON_HEADER]:
        '1 of 1 delivery jobs could not be published: broker refused the job',
    });
    // Handled, not thrown: the consumer saw no error.
    expect(setup.handlerErrors).toEqual([]);
  });

  it('dead-letters a message that is not a valid event instead of retrying it', async () => {
    const setup = await setUp();
    await setup.startConsumer();

    await setup.sendRaw(Buffer.from('this is not json'), 'garbage-1');

    await eventually(async () => {
      expect(await setup.count(setup.names.deadLetterQueue)).toBe(1);
    });
    expect(await setup.count(setup.names.dispatchQueue)).toBe(0);
    expect(setup.handlerErrors).toHaveLength(1);
    expect(setup.handlerErrors[0]).toBeInstanceOf(MalformedMessageError);
    // Straight to the DLQ: it never waited in the retry queue.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2));
    expect(await setup.count(setup.names.dispatchQueue)).toBe(0);
    expect(await setup.count(setup.names.deadLetterQueue)).toBe(1);
  });

  it('redelivers an event whose dispatcher died before acking, with the same job ids', async () => {
    const tenantId = await createTenant();
    await addEndpoint(tenantId, ['invoice.paid']);
    await addEndpoint(tenantId, ['invoice.paid']);
    const setup = await setUp();
    const event = eventFor(tenantId);
    await setup.sendEvent(event);

    // A dispatcher that publishes its jobs, then dies before acking.
    const dying = await conn.createChannel();
    const handler = new EventMessageHandler(
      new Dispatcher(
        new KyselySubscriptionLookup(db),
        new BrokerDeliveryPublisher(
          new ConfirmPublisher(await conn.createConfirmChannel()),
          setup.names,
        ),
        router,
      ),
    );
    await Consumer.start(
      dying,
      setup.names.dispatchQueue,
      async (message) => {
        await handler.handle(message);
        await new Promise<void>(() => undefined); // never acks
      },
      { prefetch: 1, onHandlerError: () => undefined },
    );
    const first = await jobsOnLanes(setup, 2);
    await dying.close();

    await setup.startConsumer();

    const second = await jobsOnLanes(setup, 2);
    // At-least-once: the jobs went out twice, under the same ids.
    expect(second.map((j) => j.messageId).sort()).toEqual(
      first.map((j) => j.messageId).sort(),
    );
  });

  it('can route any endpoint id the router produces: no job is ever unroutable', async () => {
    const setup = await setUp();
    const publisher = new ConfirmPublisher(await conn.createConfirmChannel());
    const ids = Array.from({ length: 1000 }, () => randomUUID());

    // Each publish is mandatory, so one with no lane bound would reject.
    await Promise.all(
      ids.map((id) =>
        publisher.publish(
          setup.names.deliveriesExchange,
          router.routingKey(id),
          Buffer.from('{}'),
          { messageId: id },
        ),
      ),
    );

    const counts = await Promise.all(
      Array.from({ length: LANES }, (_, lane) =>
        setup.count(setup.names.laneQueue(lane)),
      ),
    );
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(1000);
    // Every lane is used, so the shards actually share the load.
    expect(counts.every((n) => n > 0)).toBe(true);
  });
});
