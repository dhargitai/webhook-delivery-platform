import { randomUUID } from 'node:crypto';
import { type AttemptRecord, MongoAttemptLog } from '@wdp/core';
import { type Collection, type Document, MongoClient } from 'mongodb';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';
import { firstAttemptsFilter, readFirstAttempts } from './first-attempts.js';

const since = new Date('2026-11-28T12:00:00.000Z');
const after = (ms: number) => new Date(since.getTime() + ms);

function record(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    tenantId: 'tenant-a',
    endpointId: 'endpoint-1',
    eventId: 'event-1',
    deliveryId: 'delivery-1',
    attemptNo: 1,
    ts: after(1_000),
    status: 'success',
    httpStatus: 200,
    latencyMs: 20,
    ...overrides,
  };
}

describe('readFirstAttempts (real MongoDB)', () => {
  const dbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let client: MongoClient;
  let collection: Collection<Document>;
  let log: MongoAttemptLog;

  beforeAll(async () => {
    client = await MongoClient.connect(inject('mongoUrl'));
    collection = client.db(dbName).collection('attempts');
    // The worker's own writer and indexes, so the field names and the index
    // the query relies on are the real ones.
    log = new MongoAttemptLog(collection);
    await log.ensureIndexes();
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  afterAll(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });

  it("returns the run tenants' first attempts", async () => {
    await log.record(record({ eventId: 'e1', endpointId: 'ep1' }));
    await log.record(
      record({
        tenantId: 'tenant-b',
        eventId: 'e2',
        endpointId: 'ep2',
        ts: after(2_000),
        status: 'failure',
        httpStatus: 503,
        error: 'http_error: HTTP 503',
      }),
    );

    const attempts = await readFirstAttempts(collection, {
      tenantIds: ['tenant-a', 'tenant-b'],
      since,
    });

    expect(attempts.sort((x, y) => x.ts.getTime() - y.ts.getTime())).toEqual([
      { eventId: 'e1', endpointId: 'ep1', ts: after(1_000) },
      { eventId: 'e2', endpointId: 'ep2', ts: after(2_000) },
    ]);
  });

  it('leaves out retries, other tenants and attempts from before the run', async () => {
    await log.record(record({ eventId: 'wanted' }));
    await log.record(record({ eventId: 'retry', attemptNo: 2 }));
    await log.record(record({ eventId: 'other', tenantId: 'tenant-x' }));
    await log.record(record({ eventId: 'earlier', ts: after(-1) }));

    const attempts = await readFirstAttempts(collection, {
      tenantIds: ['tenant-a'],
      since,
    });

    expect(attempts.map((a) => a.eventId)).toEqual(['wanted']);
  });

  it('includes an attempt made exactly at the start of the run', async () => {
    await log.record(record({ ts: since }));

    const attempts = await readFirstAttempts(collection, {
      tenantIds: ['tenant-a'],
      since,
    });

    expect(attempts).toHaveLength(1);
  });

  it('returns nothing for no tenants', async () => {
    await log.record(record({}));

    await expect(
      readFirstAttempts(collection, { tenantIds: [], since }),
    ).resolves.toEqual([]);
  });

  it('refuses a document without the fields it needs', async () => {
    await collection.insertOne({
      tenant_id: 'tenant-a',
      attempt_no: 1,
      ts: after(1_000),
      endpoint_id: 'ep1',
    });

    await expect(
      readFirstAttempts(collection, { tenantIds: ['tenant-a'], since }),
    ).rejects.toThrow(/event_id/);
  });

  it('is served by the tenant index, never a collection scan', async () => {
    // At load-test volume a scan would read every attempt ever logged.
    await log.record(record({}));

    const plan = await collection
      .find(firstAttemptsFilter({ tenantIds: ['tenant-a', 'tenant-b'], since }))
      .explain('queryPlanner');

    const winning = JSON.stringify(
      (plan['queryPlanner'] as Document)['winningPlan'],
    );
    // The tenant index, not the TTL index on `ts` alone, which would read
    // every tenant's attempts since the run started.
    expect(winning).toContain('"indexName":"tenant_ts_idx"');
    expect(winning).not.toContain('COLLSCAN');
  });
});
