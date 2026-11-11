import type { DeliveryJob } from '../dispatch/delivery-publisher.js';
import type { AttemptOutcome } from './delivery-attempt.js';

/** One delivery attempt as the log keeps it (PRD, "Attempt document"). */
export interface AttemptRecord {
  tenantId: string;
  endpointId: string;
  eventId: string;
  deliveryId: string;
  /** 1 for the first try of a delivery. */
  attemptNo: number;
  /** When the attempt was made. A `Date`, because the 30-day TTL index needs one. */
  ts: Date;
  status: 'success' | 'failure';
  /** Absent when the receiver never answered (timeout, network error, ...). */
  httpStatus?: number;
  latencyMs: number;
  /** The start of the response body, already capped by the HTTP client. */
  responseSnippet?: string;
  /** The failure kind, plus the message when there is one. Absent on success. */
  error?: string;
}

/** Durable log of every attempt. Resolves once the record is stored. */
export abstract class AttemptLog {
  abstract record(record: AttemptRecord): Promise<void>;
}

/**
 * What to log for an attempt, or `null` when there is nothing to log: a
 * skipped attempt (endpoint missing or disabled) made no call, so it is not an
 * attempt.
 */
export function toAttemptRecord(
  job: DeliveryJob,
  outcome: AttemptOutcome,
  now: Date,
): AttemptRecord | null {
  if (outcome.kind === 'skipped') return null;

  const base = {
    tenantId: job.tenantId,
    endpointId: job.endpointId,
    eventId: job.eventId,
    deliveryId: job.deliveryId,
    attemptNo: job.attemptNo ?? 1,
    ts: now,
    latencyMs: outcome.latencyMs,
  };

  if (outcome.kind === 'delivered') {
    return {
      ...base,
      status: 'success',
      httpStatus: outcome.status,
      responseSnippet: outcome.snippet,
    };
  }
  return {
    ...base,
    status: 'failure',
    httpStatus: outcome.status,
    responseSnippet: outcome.snippet,
    error: outcome.error
      ? `${outcome.failure}: ${outcome.error}`
      : outcome.failure,
  };
}
