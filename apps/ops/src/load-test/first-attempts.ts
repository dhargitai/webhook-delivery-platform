import type { Collection, Document, Filter } from 'mongodb';
import type { FirstAttempt } from './report.js';

export interface FirstAttemptsQuery {
  tenantIds: readonly string[];
  /** The run's start: earlier attempts belong to another run. */
  since: Date;
}

/**
 * Led by `tenant_id` and `ts`, so the attempt log's `{tenant_id, ts, _id}`
 * index serves it; `attempt_no` is checked on the documents that range finds.
 */
export function firstAttemptsFilter({
  tenantIds,
  since,
}: FirstAttemptsQuery): Filter<Document> {
  return {
    tenant_id: { $in: [...tenantIds] },
    ts: { $gte: since },
    attempt_no: 1,
  };
}

/** Every first attempt the run's tenants made since it started. */
export async function readFirstAttempts(
  attempts: Collection<Document>,
  query: FirstAttemptsQuery,
): Promise<FirstAttempt[]> {
  const documents = await attempts
    .find(firstAttemptsFilter(query), {
      projection: { _id: 0, event_id: 1, endpoint_id: 1, ts: 1 },
    })
    .toArray();
  return documents.map(toFirstAttempt);
}

function toFirstAttempt(document: Document): FirstAttempt {
  const { event_id: eventId, endpoint_id: endpointId, ts } = document;
  if (typeof eventId !== 'string') {
    throw new Error(`attempt document without a string event_id`);
  }
  if (typeof endpointId !== 'string') {
    throw new Error(`attempt document ${eventId} without a string endpoint_id`);
  }
  if (!(ts instanceof Date)) {
    throw new Error(`attempt document ${eventId} without a Date ts`);
  }
  return { eventId, endpointId, ts };
}
