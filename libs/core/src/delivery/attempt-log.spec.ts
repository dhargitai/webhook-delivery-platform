import { describe, expect, it } from 'vitest';
import type { DeliveryJob } from '../dispatch/delivery-publisher.js';
import type { HttpFailureKind } from '../safe-http-client.js';
import { type AttemptRecord, toAttemptRecord } from './attempt-log.js';
import type { AttemptOutcome } from './delivery-attempt.js';

const job: DeliveryJob = {
  deliveryId: 'delivery-1',
  eventId: 'event-1',
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42' },
};
const now = new Date('2026-11-11T12:00:00.500Z');

describe('toAttemptRecord', () => {
  it('describes a delivered attempt', () => {
    const outcome: AttemptOutcome = {
      kind: 'delivered',
      status: 204,
      latencyMs: 31,
      snippet: 'ok',
    };

    expect(toAttemptRecord(job, outcome, now)).toEqual<AttemptRecord>({
      tenantId: 'tenant-1',
      endpointId: 'endpoint-1',
      eventId: 'event-1',
      deliveryId: 'delivery-1',
      attemptNo: 1,
      ts: now,
      status: 'success',
      httpStatus: 204,
      latencyMs: 31,
      responseSnippet: 'ok',
    });
  });

  it('describes a failed attempt that got an HTTP answer', () => {
    const outcome: AttemptOutcome = {
      kind: 'failed',
      failure: 'http_error',
      status: 503,
      latencyMs: 77,
      snippet: 'overloaded',
    };

    expect(toAttemptRecord(job, outcome, now)).toEqual<AttemptRecord>({
      tenantId: 'tenant-1',
      endpointId: 'endpoint-1',
      eventId: 'event-1',
      deliveryId: 'delivery-1',
      attemptNo: 1,
      ts: now,
      status: 'failure',
      httpStatus: 503,
      latencyMs: 77,
      responseSnippet: 'overloaded',
      error: 'http_error',
    });
  });

  it('names a failure by its kind and appends the message when there is one', () => {
    const outcome: AttemptOutcome = {
      kind: 'failed',
      failure: 'network_error',
      error: 'ECONNRESET',
      latencyMs: 5,
    };

    const record = toAttemptRecord(job, outcome, now);

    expect(record?.error).toBe('network_error: ECONNRESET');
    expect(record?.httpStatus).toBeUndefined();
    expect(record?.responseSnippet).toBeUndefined();
  });

  it.each<HttpFailureKind>([
    'http_error',
    'redirect',
    'response_too_large',
    'connect_timeout',
    'timeout',
    'network_error',
    'ssrf_blocked',
    'invalid_url',
  ])('records a %s failure as a failure carrying its kind', (failure) => {
    const record = toAttemptRecord(
      job,
      { kind: 'failed', failure, latencyMs: 1 },
      now,
    );

    expect(record?.status).toBe('failure');
    expect(record?.error).toBe(failure);
  });

  it('takes the attempt number from the job, and starts at 1', () => {
    const outcome: AttemptOutcome = {
      kind: 'delivered',
      status: 200,
      latencyMs: 1,
      snippet: '',
    };

    expect(toAttemptRecord(job, outcome, now)?.attemptNo).toBe(1);
    expect(
      toAttemptRecord({ ...job, attemptNo: 4 }, outcome, now)?.attemptNo,
    ).toBe(4);
  });

  it.each<AttemptOutcome>([
    { kind: 'skipped', reason: 'endpoint_missing' },
    { kind: 'skipped', reason: 'endpoint_disabled' },
  ])(
    'records nothing for a skipped attempt ($reason): no call was made',
    (outcome) => {
      expect(toAttemptRecord(job, outcome, now)).toBeNull();
    },
  );

  it('records nothing for a deferred attempt: the endpoint was not called', () => {
    const outcome: AttemptOutcome = {
      kind: 'deferred',
      reason: 'circuit_open',
    };

    expect(toAttemptRecord(job, outcome, now)).toBeNull();
  });
});
