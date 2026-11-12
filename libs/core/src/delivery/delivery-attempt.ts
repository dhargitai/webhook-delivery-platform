import { breakerOutcome, type EndpointCircuit } from '../circuit-breaker.js';
import type { DeliveryJob } from '../dispatch/delivery-publisher.js';
import type { HttpFailureKind, HttpResult } from '../safe-http-client.js';
import type { SignatureService } from '../signature-service.js';
import type { EndpointTargetLookup } from './endpoint-target-lookup.js';

/** What happened to one attempt. A failed HTTP call is an outcome, not a throw. */
export type AttemptOutcome =
  | { kind: 'delivered'; status: number; latencyMs: number; snippet: string }
  | {
      kind: 'failed';
      failure: HttpFailureKind;
      status?: number;
      error?: string;
      latencyMs: number;
      snippet?: string;
    }
  | { kind: 'skipped'; reason: 'endpoint_missing' | 'endpoint_disabled' }
  /** The endpoint was not called now, but will be later: put the job back. */
  | { kind: 'deferred'; reason: 'circuit_open' };

export interface DeliveryAttemptDeps {
  lookup: EndpointTargetLookup;
  client: {
    post(
      url: string,
      headers: Record<string, string>,
      body: string,
    ): Promise<HttpResult>;
  };
  /** The endpoint's circuit: asked before the call, told its result after. */
  breaker: EndpointCircuit;
  signatures: SignatureService;
  now: () => Date;
}

/**
 * One try at delivering one job: read the endpoint, ask its circuit, sign the
 * event and POST it, then tell the circuit how the call went. It decides
 * nothing about what a failure means (retry, give up); it only reports what
 * happened, so that policy can change without touching it.
 */
export class DeliveryAttempt {
  constructor(private readonly deps: DeliveryAttemptDeps) {}

  /** Rejects only when the endpoint lookup fails; HTTP failures are outcomes. */
  async attempt(job: DeliveryJob): Promise<AttemptOutcome> {
    const target = await this.deps.lookup.find(job.tenantId, job.endpointId);
    // The endpoint may have been deleted or disabled after the job was queued.
    if (!target) return { kind: 'skipped', reason: 'endpoint_missing' };
    if (target.status !== 'active') {
      return { kind: 'skipped', reason: 'endpoint_disabled' };
    }

    // Asked only once a call is sure to follow: a probe elected for a job
    // that is then skipped would hold the election without testing anything.
    const decision = await this.deps.breaker.allow(job.endpointId);
    if (decision.kind === 'deny') {
      return { kind: 'deferred', reason: 'circuit_open' };
    }

    // Serialised once: these exact bytes are signed and sent.
    const body = JSON.stringify({
      id: job.eventId,
      type: job.eventType,
      data: job.payload,
    });
    // The id is stable across attempts so receivers can deduplicate; the
    // timestamp is taken on every attempt, so a retry hours later still falls
    // inside the receiver's tolerance window.
    const webhookId = job.deliveryId;
    const timestamp = Math.floor(this.deps.now().getTime() / 1000);
    const signature = this.deps.signatures.sign(
      [target.signingSecret],
      webhookId,
      timestamp,
      body,
    );

    const result = await this.deps.client.post(
      target.url,
      {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      },
      body,
    );
    // A probe's token is what lets its result, and no other, close or reopen
    // a half-open circuit.
    await this.deps.breaker.record(
      job.endpointId,
      breakerOutcome(result),
      decision.kind === 'probe' ? decision.token : undefined,
    );

    if (result.outcome === 'success') {
      return {
        kind: 'delivered',
        status: result.status,
        latencyMs: result.latencyMs,
        snippet: result.snippet,
      };
    }
    return {
      kind: 'failed',
      failure: result.kind,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
      snippet: result.snippet,
    };
  }
}
