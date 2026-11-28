import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createDatabase, type Database, LaneRouter } from '@wdp/core';
import {
  createTestDatabase,
  type TestDatabase,
  testKek,
} from '@wdp/core/testing';
import { testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createMockReceiver,
  type MockReceiver,
} from '../apps/mock-receiver/src/mock-receiver.js';
import { LoadApiClient } from '../apps/ops/src/load-test/api-client.js';
import { systemClock } from '../apps/ops/src/load-test/pacer.js';
import { runLoadTest } from '../apps/ops/src/load-test/run-load-test.js';

/**
 * The load-test command at toy scale, against the real apps and the real mock
 * receiver: what it reports must match what the pipeline actually did.
 */
describe('load test (e2e)', () => {
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let mongo: MongoClient;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let api: NestExpressApplication;
  let apiBase: string;
  const services: INestApplicationContext[] = [];
  let receiver: MockReceiver;
  let receiverBase: string;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    mongo = await MongoClient.connect(inject('mongoUrl'));

    receiver = createMockReceiver();
    const receiverPort = await receiver.listen(0, '127.0.0.1');
    receiverBase = `http://localhost:${receiverPort}`;

    // Each app's config module validates the environment while its module file
    // is evaluated, so every variable must exist before the imports below.
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = inject('redisUrl');
    process.env.SECRETS_KEK_V1 = testKek();
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = testingNamespace();
    // One lane: every victim endpoint shares the hanging endpoint's lane.
    process.env.LANE_COUNT = '1';
    process.env.RELAY_POLL_INTERVAL_MS = '20';
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    process.env.TIME_SCALE = '1000';
    process.env.RETRY_MIN_DELAY_MS = '20';

    const { AppModule } = await import('../apps/api/src/app.module.js');
    const { configureApp } = await import('../apps/api/src/configure-app.js');
    const { RelayModule } = await import('../apps/relay/src/relay.module.js');
    const { DispatcherModule } =
      await import('../apps/dispatcher/src/dispatcher.module.js');
    const { WorkerModule } =
      await import('../apps/worker/src/worker.module.js');

    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    api = apiModule.createNestApplication<NestExpressApplication>();
    configureApp(api);
    // A real port: the command calls the API over HTTP, as it does in Compose.
    await api.listen(0, '127.0.0.1');
    const apiPort = (api.getHttpServer().address() as AddressInfo).port;
    apiBase = `http://127.0.0.1:${apiPort}`;

    for (const module of [RelayModule, DispatcherModule, WorkerModule]) {
      const service = await Test.createTestingModule({
        imports: [module],
      }).compile();
      await service.init();
      services.push(service);
    }
  });

  afterAll(async () => {
    // The receiver first: it drops the hanging requests, so the worker's
    // shutdown does not wait out their 10 s timeouts.
    await receiver.close();
    await api.close();
    for (const service of services) {
      await service.close();
    }
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
  });

  it('accounts for every victim delivery while a noisy tenant floods a hanging endpoint', async () => {
    const client = new LoadApiClient(apiBase);
    const report = await runLoadTest(
      {
        db,
        attempts: mongo.db(mongoDbName).collection('attempts'),
        api: client,
        lanes: new LaneRouter(1),
        clock: systemClock,
      },
      {
        label: 'e2e',
        tenants: 2,
        ratePerTenant: 10,
        fanout: 1,
        noisyRate: 300,
        receiverBaseUrl: receiverBase,
        durationSeconds: 2,
        drainSeconds: 40,
      },
    );
    client.close();

    // 2 victims x 10/s x 2 s, each event to one endpoint, all of them on the
    // hanging endpoint's only lane, and every one found in the attempt log.
    expect(report.missing).toBe(0);
    expect(report.hangingLane.count).toBe(40);
    expect(report.otherLanes.count).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.victimRateLimited).toBe(0);
    // 600 tries against a 100/s limit with a burst of 200.
    expect(report.noisyRateLimited).toBeGreaterThan(0);
    // The noisy tenant's accepted events count toward the ingest rate.
    expect(report.acceptedPerSecond).toBeGreaterThan(40 / 2);
    // Its deliveries really reached the hanging endpoint.
    expect(receiver.stats().hung).toBeGreaterThan(0);
  }, 90_000);
});
