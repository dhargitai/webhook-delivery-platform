import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  generateEndpointSecret,
  SignatureService,
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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';

const LANES = 4;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

describe('worker (real Postgres and RabbitMQ)', () => {
  const namespace = testingNamespace();
  const names: TopologyNames = topologyNames(namespace);
  const signatures = new SignatureService();
  const brokerErrors: Error[] = [];

  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let publisher: ConfirmPublisher;
  let worker: TestingModule;
  let receiverServer: Server;
  let receiverPort: number;
  let receiverUrl: string;
  const received: Received[] = [];
  let receiverStatus = 200;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      brokerErrors.push(e),
    );
    // The worker declares this too (it is idempotent); declaring it here keeps
    // the queues readable even where the worker fails to start.
    const setup = await conn.createChannel();
    await declareTopology(setup, { laneCount: LANES, namespace });
    await setup.close();
    publisher = new ConfirmPublisher(await conn.createConfirmChannel());

    // A receiver on loopback, which only the allowlist lets the worker reach:
    // the name `localhost` is on it, the address and other names are not.
    receiverServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.statusCode = receiverStatus;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    receiverPort = (receiverServer.address() as AddressInfo).port;
    receiverUrl = `http://localhost:${receiverPort}/hook`;

    // The config module validates the environment while the worker module is
    // evaluated, so the import comes after the environment is set.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
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
    expect(brokerErrors).toEqual([]);
  });

  beforeEach(async () => {
    received.length = 0;
    receiverStatus = 200;
    await drain(names.deadLetterQueue);
  });

  async function drain(queue: string) {
    const channel = await conn.createChannel();
    const messages = [];
    for (;;) {
      const message = await channel.get(queue, { noAck: true });
      if (message === false) break;
      messages.push(message);
    }
    await channel.close();
    return messages;
  }

  async function count(queue: string): Promise<number> {
    const channel = await conn.createChannel();
    const { messageCount } = await channel.checkQueue(queue);
    await channel.close();
    return messageCount;
  }

  async function laneBacklog(): Promise<number> {
    let total = 0;
    for (let lane = 0; lane < LANES; lane++) {
      total += await count(names.laneQueue(lane));
    }
    return total;
  }

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
    {
      url = receiverUrl,
      status = 'active',
    }: { url?: string; status?: 'active' | 'disabled' } = {},
  ): Promise<{ id: string; secret: string }> {
    const secret = generateEndpointSecret();
    const row = await db
      .insertInto('endpoints')
      .values({ tenant_id: tenantId, url, signing_secret: secret, status })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, secret };
  }

  function jobFor(tenantId: string, endpointId: string): DeliveryJob {
    return {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId,
      endpointId,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
    };
  }

  async function publishJob(job: DeliveryJob, lane = 0): Promise<void> {
    await publisher.publish(
      names.deliveriesExchange,
      laneRoutingKey(lane),
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );
  }

  /** Waits until the lanes are empty, which only an ack achieves. */
  async function untilAcked(): Promise<void> {
    await eventually(async () => {
      expect(await laneBacklog()).toBe(0);
    });
    // Anything the worker would still reject or redeliver shows up by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  it('delivers a job to its endpoint, signed, and acks it', async () => {
    const tenantId = await createTenant();
    const { id, secret } = await addEndpoint(tenantId);
    const job = jobFor(tenantId, id);

    await publishJob(job);

    await eventually(() => expect(received).toHaveLength(1));
    const [request] = received as [Received];
    expect(JSON.parse(request.body)).toEqual({
      id: job.eventId,
      type: 'invoice.paid',
      data: { invoice: 'INV-42' },
    });
    expect(request.headers['webhook-id']).toBe(job.deliveryId);
    expect(
      signatures.verify(
        String(request.headers['webhook-signature']),
        String(request.headers['webhook-id']),
        Number(request.headers['webhook-timestamp']),
        request.body,
        [secret],
        new Date(),
      ),
    ).toBe(true);
    await untilAcked();
    expect(received).toHaveLength(1);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  it('consumes every lane', async () => {
    const tenantId = await createTenant();
    const { id } = await addEndpoint(tenantId);

    for (let lane = 0; lane < LANES; lane++) {
      await publishJob(jobFor(tenantId, id), lane);
    }

    await eventually(() => expect(received).toHaveLength(LANES));
    await untilAcked();
  });

  it('sends the same webhook id with a fresh timestamp when a job comes again', async () => {
    const tenantId = await createTenant();
    const { id, secret } = await addEndpoint(tenantId);
    const job = jobFor(tenantId, id);

    await publishJob(job);
    await eventually(() => expect(received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await publishJob(job);
    await eventually(() => expect(received).toHaveLength(2));

    const [first, second] = received as [Received, Received];
    expect(second.headers['webhook-id']).toBe(first.headers['webhook-id']);
    expect(Number(second.headers['webhook-timestamp'])).toBeGreaterThan(
      Number(first.headers['webhook-timestamp']),
    );
    expect(
      signatures.verify(
        String(second.headers['webhook-signature']),
        String(second.headers['webhook-id']),
        Number(second.headers['webhook-timestamp']),
        second.body,
        [secret],
        new Date(),
      ),
    ).toBe(true);
  });

  it('acks a job whose receiver fails, without redelivering or dead-lettering it', async () => {
    const tenantId = await createTenant();
    const { id } = await addEndpoint(tenantId);
    receiverStatus = 503;

    await publishJob(jobFor(tenantId, id));

    await eventually(() => expect(received).toHaveLength(1));
    await untilAcked();
    expect(received).toHaveLength(1);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  // The receiver answers on loopback, so a request that gets through shows up
  // in `received`: these fail if the guard is not wired into the client.
  it.each([
    {
      name: 'an IP address that is not on the allowlist',
      host: '127.0.0.1',
    },
    {
      name: 'a name that is not on the allowlist but resolves to loopback',
      host: 'localhost.',
    },
  ])('acks a job for $name without calling it', async ({ host }) => {
    const tenantId = await createTenant();
    const { id } = await addEndpoint(tenantId, {
      url: `http://${host}:${receiverPort}/hook`,
    });

    await publishJob(jobFor(tenantId, id));

    await untilAcked();
    expect(received).toHaveLength(0);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  it('acks a job for a disabled endpoint without calling it', async () => {
    const tenantId = await createTenant();
    const { id } = await addEndpoint(tenantId, { status: 'disabled' });

    await publishJob(jobFor(tenantId, id));

    await untilAcked();
    expect(received).toHaveLength(0);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  it('acks a job for a deleted endpoint without calling anything', async () => {
    const tenantId = await createTenant();
    const { id } = await addEndpoint(tenantId);
    await db.deleteFrom('endpoints').where('id', '=', id).execute();

    await publishJob(jobFor(tenantId, id));

    await untilAcked();
    expect(received).toHaveLength(0);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  it('does not call another tenant’s endpoint, whatever tenant the job claims', async () => {
    const owner = await createTenant();
    const intruder = await createTenant();
    const { id } = await addEndpoint(owner);

    await publishJob(jobFor(intruder, id));

    await untilAcked();
    expect(received).toHaveLength(0);
  });

  it('dead-letters a malformed message instead of acking or looping on it', async () => {
    const channel = await conn.createConfirmChannel();
    const raw = new ConfirmPublisher(channel);

    await raw.publish(
      names.deliveriesExchange,
      laneRoutingKey(0),
      Buffer.from('{not json'),
      { messageId: 'garbage' },
    );

    await eventually(async () => {
      expect(await count(names.deadLetterQueue)).toBe(1);
    });
    expect(await laneBacklog()).toBe(0);
    expect(received).toHaveLength(0);
    await channel.close();
  });
});
