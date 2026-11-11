import type { Collection, Document } from 'mongodb';
import { AttemptLog, type AttemptRecord } from './attempt-log.js';

/** PRD: the attempt log keeps 30 days, the same as the `events` rows replay reads. */
export const ATTEMPT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Every filter the delivery log offers starts with the tenant and is read
 * newest first, so each index ends in `ts` and `_id` descending: the sort is
 * then served by the index and needs no in-memory SORT stage. The event index
 * takes `ts` too, for the same reason.
 */
const LOG_INDEXES = [
  {
    name: 'tenant_ts_idx',
    key: { tenant_id: 1, ts: -1, _id: -1 },
  },
  {
    name: 'tenant_endpoint_ts_idx',
    key: { tenant_id: 1, endpoint_id: 1, ts: -1, _id: -1 },
  },
  {
    name: 'tenant_status_ts_idx',
    key: { tenant_id: 1, status: 1, ts: -1, _id: -1 },
  },
  {
    name: 'tenant_event_ts_idx',
    key: { tenant_id: 1, event_id: 1, ts: -1, _id: -1 },
  },
] as const;

/** The stored shape: the PRD's snake_case fields; absent ones are left out. */
function toDocument(record: AttemptRecord): Document {
  return {
    tenant_id: record.tenantId,
    endpoint_id: record.endpointId,
    event_id: record.eventId,
    delivery_id: record.deliveryId,
    attempt_no: record.attemptNo,
    ts: record.ts,
    status: record.status,
    ...(record.httpStatus !== undefined && { http_status: record.httpStatus }),
    latency_ms: record.latencyMs,
    ...(record.responseSnippet !== undefined && {
      response_snippet: record.responseSnippet,
    }),
    ...(record.error !== undefined && { error: record.error }),
  };
}

/** The attempt log in a MongoDB collection (append-only, expiring after 30 days). */
export class MongoAttemptLog extends AttemptLog {
  constructor(private readonly attempts: Collection<Document>) {
    super();
  }

  /**
   * Creates the log's indexes and its TTL. Idempotent, so the worker can call
   * it on every boot; MongoDB refuses a same-named index with other options,
   * which turns drift into a loud failure instead of a silent second index.
   */
  async ensureIndexes(): Promise<void> {
    for (const { name, key } of LOG_INDEXES) {
      await this.attempts.createIndex({ ...key }, { name });
    }
    // A TTL index must be on one field; the compound indexes above can't expire.
    await this.attempts.createIndex(
      { ts: 1 },
      { name: 'ts_ttl_idx', expireAfterSeconds: ATTEMPT_RETENTION_SECONDS },
    );
  }

  async record(record: AttemptRecord): Promise<void> {
    await this.attempts.insertOne(toDocument(record));
  }
}
