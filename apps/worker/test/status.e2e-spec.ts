import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { testingNamespace } from '@wdp/messaging/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

describe('worker status (e2e)', () => {
  let app: INestApplication;
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    // The config module validates the environment while worker.module.ts is
    // evaluated, so the import comes after the environment is set. The worker
    // connects to the database and the broker when it starts.
    process.env.PORT = '3001';
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.BROKER_NAMESPACE = testingNamespace();
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.MONGO_DB = `wdp_test_${randomUUID().replaceAll('-', '')}`;
    const { WorkerModule } = await import('../src/worker.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  it('answers GET /status with 200 and an ok body, with no auth and no /v1 prefix', async () => {
    const response = await request(app.getHttpServer()).get('/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
