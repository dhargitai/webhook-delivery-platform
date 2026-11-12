import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
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
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { type Collection, type Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BROKER, DATABASE, MONGO } from './tokens.js';

const LANES = 4;

interface Received {
  headers: IncomingHttpHeaders;
  at: number;
}

/**
 * What a crash looks like to the broker: the socket is gone with no close
 * handshake, so every message the worker still held unacked is redelivered.
 * amqplib keeps the socket on the connection but does not type it.
 */
function kill(connection: BrokerConnection): void {
  const { model } = connection as unknown as {
    model: { connection: { stream: Socket } };
  };
  model.connection.stream.destroy();
}

describe('a worker that dies mid-delivery (real Postgres, RabbitMQ and MongoDB)', () => {
  const namespace = testingNamespace();
  const names: TopologyNames = topologyNames(namespace);
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  const workers: TestingModule[] = [];
  const crashed: TestingModule[] = [];
  let mongo: MongoClient;
  let attempts: Collection<Document>;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let publisher: ConfirmPublisher;
  let WorkerModule: typeof import('./worker.module.js').WorkerModule;
  let receiverServer: Server;
  let receiverUrl: string;
  const received: Received[] = [];
  // The first request for each webhook id is held open, like a receiver that
  // is slow to answer; the test lets it go once it is done.
  const held: ServerResponse[] = [];
  const seen = new Set<string>();

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    mongo = await MongoClient.connect(inject('mongoUrl'));
    attempts = mongo.db(mongoDbName).collection('attempts');
    conn = await BrokerConnection.connect(inject('rabbitUrl'), () => undefined);
    const setup = await conn.createChannel();
    await declareTopology(setup, { laneCount: LANES, namespace });
    await setup.close();
    publisher = new ConfirmPublisher(await conn.createConfirmChannel());

    receiverServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const id = String(req.headers['webhook-id']);
        received.push({ headers: req.headers, at: Date.now() });
        if (seen.has(id)) {
          res.end('ok');
        } else {
          seen.add(id);
          held.push(res);
        }
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    const { port } = receiverServer.address() as AddressInfo;
    receiverUrl = `http://localhost:${port}/hook`;

    // The config module validates the environment while the worker module is
    // evaluated, so the import comes after the environment is set.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    ({ WorkerModule } = await import('./worker.module.js'));
  });

  afterAll(async () => {
    // Let the dead worker's request go, so its handler can end.
    for (const res of held) res.end('late');
    // A killed worker cannot close its broker connection, and Nest would wait
    // on it for ever. A dead process takes its connections with it; do the
    // same for the ones that are not the broker's.
    for (const worker of crashed) {
      await worker.get<Kysely<Database>>(DATABASE).destroy();
      await worker.get<MongoClient>(MONGO).close();
    }
    for (const worker of workers) {
      await worker.close();
    }
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await conn.close();
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
  });

  async function bootWorker(): Promise<TestingModule> {
    const worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init();
    workers.push(worker);
    return worker;
  }

  async function count(queue: string): Promise<number> {
    const channel = await conn.createChannel();
    const { messageCount } = await channel.checkQueue(queue);
    await channel.close();
    return messageCount;
  }

  it('loses no job: another worker delivers it, with the same webhook id', async () => {
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

    const first = await bootWorker();
    await publisher.publish(
      names.deliveriesExchange,
      laneRoutingKey(0),
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );
    // The receiver holds the request: the job is in flight and not acked.
    await eventually(() => expect(received).toHaveLength(1));

    kill(first.get<BrokerConnection>(BROKER));
    workers.splice(workers.indexOf(first), 1);
    crashed.push(first);
    await bootWorker();

    await eventually(() => expect(received).toHaveLength(2));
    const [original, redelivered] = received as [Received, Received];
    expect(redelivered.headers['webhook-id']).toBe(job.deliveryId);
    expect(redelivered.headers['webhook-id']).toBe(
      original.headers['webhook-id'],
    );
    expect(redelivered.at).toBeGreaterThanOrEqual(original.at);

    // The second worker finished it: logged as a success, acked, nothing lost
    // to the dead-letter queue.
    await eventually(async () => {
      expect(
        await attempts.countDocuments({
          delivery_id: job.deliveryId,
          status: 'success',
        }),
      ).toBe(1);
    });
    for (let lane = 0; lane < LANES; lane++) {
      await eventually(async () => {
        expect(await count(names.laneQueue(lane))).toBe(0);
      });
    }
    expect(await count(names.deadLetterQueue)).toBe(0);
  });
});
