import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  generateEndpointSecret,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { laneRoutingKey } from '@wdp/domain';
import {
  BrokerConnection,
  ConfirmPublisher,
  declareTopology,
  encodeMessage,
  topologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

const LANES = 4;

// Its own spec file: the worker's config is read once per module graph, and
// this worker needs a different REDIS_URL from the other specs' workers.
describe('a worker whose Redis is unreachable (real Postgres, RabbitMQ and MongoDB)', () => {
  const namespace = testingNamespace();
  const names = topologyNames(namespace);
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let mongo: MongoClient;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let publisher: ConfirmPublisher;
  let worker: TestingModule;
  let receiverServer: Server;
  let receiverUrl: string;
  const received: string[] = [];

  beforeAll(async () => {
    // Silenced: the worker reports every failed Redis call, as it should.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    mongo = await MongoClient.connect(inject('mongoUrl'));
    conn = await BrokerConnection.connect(inject('rabbitUrl'), () => undefined);
    const setup = await conn.createChannel();
    await declareTopology(setup, { laneCount: LANES, namespace });
    await setup.close();
    publisher = new ConfirmPublisher(await conn.createConfirmChannel());

    receiverServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push(String(req.headers['webhook-id']));
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    const { port } = receiverServer.address() as AddressInfo;
    receiverUrl = `http://localhost:${port}/hook`;

    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    // Nothing listens on port 1: every Redis call fails.
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    process.env.TIME_SCALE = '1000';
    process.env.RETRY_MIN_DELAY_MS = '20';
    const { WorkerModule } = await import('./worker.module.js');
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init();
  });

  afterAll(async () => {
    await worker.close();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await conn.close();
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
    vi.restoreAllMocks();
  });

  it('delivers without the breaker, and without waiting for Redis to come back', async () => {
    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const endpoint = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenant.id,
        url: receiverUrl,
        signing_secret: generateEndpointSecret(),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const job: DeliveryJob = {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId: tenant.id,
      endpointId: endpoint.id,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
    };

    await publisher.publish(
      names.deliveriesExchange,
      laneRoutingKey(0),
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );

    // Each delivery asks Redis twice (allow, then record). A client that
    // queued those calls through its reconnect attempts would hold the job
    // for seconds; failing them fast keeps a Redis outage from slowing
    // deliveries down.
    await eventually(
      async () => {
        expect(received).toEqual([job.deliveryId]);
        expect(
          await mongo
            .db(mongoDbName)
            .collection('attempts')
            .countDocuments({ delivery_id: job.deliveryId, status: 'success' }),
        ).toBe(1);
      },
      { timeoutMs: 2_000 },
    );
  });
});
