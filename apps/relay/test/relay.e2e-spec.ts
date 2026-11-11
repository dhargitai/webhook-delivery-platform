import { randomUUID } from 'node:crypto';
import { type INestApplicationContext, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createDatabase, type Database } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import {
  BrokerConnection,
  declareEventTopology,
  topologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

describe('relay app (e2e)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let tenantId: string;
  let names: ReturnType<typeof topologyNames>;
  let RelayModule: typeof import('../src/relay.module.js').RelayModule;
  const running: INestApplicationContext[] = [];
  const brokerErrors: Error[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    const namespace = testingNamespace();
    names = topologyNames(namespace);
    // The config module validates the environment while relay.module.ts is
    // evaluated, so the variables must exist before that import.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.BROKER_NAMESPACE = namespace;
    process.env.RELAY_POLL_INTERVAL_MS = '20';
    process.env.RELAY_BATCH_SIZE = '50';
    ({ RelayModule } = await import('../src/relay.module.js'));

    db = createDatabase(testDb.url);
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      brokerErrors.push(e),
    );
    // Declared up front so the specs can inspect and purge the queue.
    await declareEventTopology(await conn.createChannel(), { namespace });
    const tenant = await db
      .insertInto('tenants')
      .values({ name: 'relay-e2e' })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  beforeEach(async () => {
    await db.deleteFrom('events').execute();
    const channel = await conn.createChannel();
    await channel.purgeQueue(names.dispatchQueue);
    await channel.close();
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await conn.close();
    await db.destroy();
    await testDb.drop();
  });

  async function startRelay(): Promise<INestApplicationContext> {
    const moduleRef = await Test.createTestingModule({
      imports: [RelayModule],
    }).compile();
    // A TestingModule is itself an application context: init() runs the
    // bootstrap hooks and close() the shutdown ones, with no HTTP server.
    await moduleRef.init();
    running.push(moduleRef);
    return moduleRef;
  }

  async function addEvents(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    const base = Date.now() - 1_000_000;
    await db
      .insertInto('events')
      .values(
        ids.map((id, i) => ({
          event_id: id,
          tenant_id: tenantId,
          idempotency_key: null,
          request_hash: 'hash',
          event_type: 'invoice.paid',
          payload: JSON.stringify({ i }),
          created_at: new Date(base + i),
        })),
      )
      .execute();
    return ids;
  }

  const unpublished = async () =>
    Number(
      (
        await db
          .selectFrom('events')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('published_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).n,
    );

  async function queued(): Promise<number> {
    const channel = await conn.createChannel();
    const { messageCount } = await channel.checkQueue(names.dispatchQueue);
    await channel.close();
    return messageCount;
  }

  it('publishes events that arrive while it is running', async () => {
    await startRelay();

    await addEvents(3);

    await eventually(async () => {
      expect(await unpublished()).toBe(0);
      expect(await queued()).toBe(3);
    });
  });

  it('picks up events that were already waiting when it started', async () => {
    await addEvents(5);

    await startRelay();

    await eventually(async () => {
      expect(await unpublished()).toBe(0);
      expect(await queued()).toBe(5);
    });
  });

  it('drains a backlog larger than one batch', async () => {
    await addEvents(130);

    await startRelay();

    await eventually(async () => {
      expect(await unpublished()).toBe(0);
      expect(await queued()).toBe(130);
    });
  });

  it('declares the queue it publishes to, so it works against a fresh broker', async () => {
    const channel = await conn.createChannel();
    await channel.deleteQueue(names.dispatchQueue);
    await addEvents(1);

    await startRelay();

    await eventually(async () => {
      expect(await unpublished()).toBe(0);
      expect(await queued()).toBe(1);
    });
  });

  it('stops cleanly when closed: no more publishing, and no run left to fail on closed connections', async () => {
    // A loop that outlived its connections would log a failed run each time
    // it woke up, so any logged error means the stop was not graceful.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const app = await startRelay();
      await addEvents(1);
      await eventually(async () => {
        expect(await unpublished()).toBe(0);
      });

      await expect(app.close()).resolves.toBeUndefined();
      running.length = 0;
      await addEvents(1);
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(await unpublished()).toBe(1);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
