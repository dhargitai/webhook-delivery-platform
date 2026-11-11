import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('worker status (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The config module validates the environment while worker.module.ts is
    // evaluated, so the import comes after the environment is set.
    process.env.PORT = '3001';
    // Required by the config schema; nothing connects before the worker
    // consumes the lanes.
    process.env.DATABASE_URL = 'postgres://unused:unused@localhost:5432/unused';
    process.env.RABBITMQ_URL = 'amqp://unused:unused@localhost:5672';
    const { WorkerModule } = await import('../src/worker.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers GET /status with 200 and an ok body, with no auth and no /v1 prefix', async () => {
    const response = await request(app.getHttpServer()).get('/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
