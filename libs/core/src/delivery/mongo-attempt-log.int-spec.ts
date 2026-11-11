import { randomUUID } from 'node:crypto';
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
import type { AttemptRecord } from './attempt-log.js';
import {
  ATTEMPT_RETENTION_SECONDS,
  MongoAttemptLog,
} from './mongo-attempt-log.js';

const success: AttemptRecord = {
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventId: 'event-1',
  deliveryId: 'delivery-1',
  attemptNo: 1,
  ts: new Date('2026-11-11T12:00:00.500Z'),
  status: 'success',
  httpStatus: 204,
  latencyMs: 31,
  responseSnippet: 'ok',
};

const failure: AttemptRecord = {
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventId: 'event-1',
  deliveryId: 'delivery-1',
  attemptNo: 2,
  ts: new Date('2026-11-11T12:00:05.000Z'),
  status: 'failure',
  latencyMs: 10_000,
  error: 'timeout: no answer in 10000 ms',
};

describe('MongoAttemptLog (real MongoDB)', () => {
  const dbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let client: MongoClient;
  let collection: Collection<Document>;
  let log: MongoAttemptLog;

  beforeAll(async () => {
    client = await MongoClient.connect(inject('mongoUrl'));
    collection = client.db(dbName).collection('attempts');
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

  async function stored(): Promise<Document[]> {
    return collection.find({}, { projection: { _id: 0 } }).toArray();
  }

  describe('record', () => {
    it('stores a success under the PRD field names', async () => {
      await log.record(success);

      expect(await stored()).toEqual([
        {
          tenant_id: 'tenant-1',
          endpoint_id: 'endpoint-1',
          event_id: 'event-1',
          delivery_id: 'delivery-1',
          attempt_no: 1,
          ts: success.ts,
          status: 'success',
          http_status: 204,
          latency_ms: 31,
          response_snippet: 'ok',
        },
      ]);
    });

    it('stores a failure with its error', async () => {
      await log.record(failure);

      expect(await stored()).toEqual([
        {
          tenant_id: 'tenant-1',
          endpoint_id: 'endpoint-1',
          event_id: 'event-1',
          delivery_id: 'delivery-1',
          attempt_no: 2,
          ts: failure.ts,
          status: 'failure',
          latency_ms: 10_000,
          error: 'timeout: no answer in 10000 ms',
        },
      ]);
    });

    it('leaves out the fields an attempt does not have, rather than storing null', async () => {
      await log.record(failure);

      const [doc] = await stored();
      expect(Object.keys(doc ?? {})).not.toEqual(
        expect.arrayContaining(['http_status']),
      );
      expect(Object.keys(doc ?? {})).not.toEqual(
        expect.arrayContaining(['response_snippet']),
      );
    });

    it('stores ts as a BSON date, which the TTL index needs', async () => {
      await log.record(success);

      const doc = await collection.findOne({});
      expect(doc?.['ts']).toBeInstanceOf(Date);
      const types = await collection
        .aggregate([{ $project: { type: { $type: '$ts' } } }])
        .toArray();
      expect(types[0]?.['type']).toBe('date');
    });

    it('keeps every attempt of a delivery as its own document', async () => {
      await log.record(success);
      await log.record(failure);

      expect(
        await collection.countDocuments({ delivery_id: 'delivery-1' }),
      ).toBe(2);
    });
  });

  describe('ensureIndexes', () => {
    async function keys(): Promise<[string, number][][]> {
      const indexes = await collection.indexes();
      // Entries, not objects: the order of the fields is what an index is.
      return indexes.map((i) => Object.entries(i.key) as [string, number][]);
    }

    it.each([
      [
        'tenant, newest first',
        [
          ['tenant_id', 1],
          ['ts', -1],
          ['_id', -1],
        ],
      ],
      [
        'tenant and endpoint, newest first',
        [
          ['tenant_id', 1],
          ['endpoint_id', 1],
          ['ts', -1],
          ['_id', -1],
        ],
      ],
      [
        'tenant and status, newest first',
        [
          ['tenant_id', 1],
          ['status', 1],
          ['ts', -1],
          ['_id', -1],
        ],
      ],
      [
        'tenant and event, newest first',
        [
          ['tenant_id', 1],
          ['event_id', 1],
          ['ts', -1],
          ['_id', -1],
        ],
      ],
    ])('creates the index for %s', async (_name, key) => {
      expect(await keys()).toContainEqual(key);
    });

    it('expires attempts 30 days after ts', async () => {
      expect(ATTEMPT_RETENTION_SECONDS).toBe(30 * 24 * 60 * 60);

      const indexes = await collection.indexes();
      const ttl = indexes.find(
        (i) => Object.keys(i.key).length === 1 && i.key['ts'] === 1,
      );
      expect(ttl?.expireAfterSeconds).toBe(2_592_000);
    });

    it('can run on every boot: a second run adds no index and does not fail', async () => {
      const before = await keys();

      await log.ensureIndexes();

      expect(await keys()).toEqual(before);
      expect(before).toHaveLength(6); // the _id index, four compound, one TTL
    });
  });

  describe('the log queries', () => {
    // The index each query must be served from. Another index could answer
    // it without a SORT too, by scanning far more of the tenant's log.
    const queries: [string, Document, string][] = [
      ['a tenant’s log', { tenant_id: 'tenant-1' }, 'tenant_ts_idx'],
      [
        'one endpoint’s log',
        { tenant_id: 'tenant-1', endpoint_id: 'endpoint-1' },
        'tenant_endpoint_ts_idx',
      ],
      [
        'one status',
        { tenant_id: 'tenant-1', status: 'failure' },
        'tenant_status_ts_idx',
      ],
      [
        'one event',
        { tenant_id: 'tenant-1', event_id: 'event-1' },
        'tenant_event_ts_idx',
      ],
    ];

    beforeEach(async () => {
      await log.record(success);
      await log.record(failure);
    });

    it.each(queries)(
      'serves %s from its own index, newest first, without sorting',
      async (_name, filter, indexName) => {
        const plan = await collection
          .find(filter)
          .sort({ ts: -1, _id: -1 })
          .limit(51)
          .explain('queryPlanner');

        const winning = JSON.stringify(
          (plan['queryPlanner'] as Document)['winningPlan'],
        );
        expect(winning).toContain('IXSCAN');
        expect(winning).toContain(`"indexName":"${indexName}"`);
        expect(winning).not.toMatch(/"stage":"SORT/);
        expect(winning).not.toContain('COLLSCAN');
      },
    );
  });
});
