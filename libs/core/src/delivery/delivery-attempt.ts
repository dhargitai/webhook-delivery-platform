import type { DeliveryJob } from '../dispatch/delivery-publisher.js';
import type { HttpFailureKind, HttpResult } from '../safe-http-client.js';
import type { SignatureService } from '../signature-service.js';
import type { EndpointTargetLookup } from './endpoint-target-lookup.js';

/** What happened to one attempt. A failed HTTP call is an outcome, not a throw. */
export type AttemptOutcome =
  | { kind: 'delivered'; status: number; latencyMs: number }
  | {
      kind: 'failed';
      failure: HttpFailureKind;
      status?: number;
      error?: string;
      latencyMs: number;
    }
  | { kind: 'skipped'; reason: 'endpoint_missing' | 'endpoint_disabled' };

export interface DeliveryAttemptDeps {
  lookup: EndpointTargetLookup;
  client: {
    post(
      url: string,
      headers: Record<string, string>,
      body: string,
    ): Promise<HttpResult>;
  };
  signatures: SignatureService;
  now: () => Date;
}

/**
 * One try at delivering one job: read the endpoint, sign the event and POST
 * it. It decides nothing about what a failure means (retry, give up); it only
 * reports what happened, so that policy can change without touching it.
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

    if (result.outcome === 'success') {
      return {
        kind: 'delivered',
        status: result.status,
        latencyMs: result.latencyMs,
      };
    }
    return {
      kind: 'failed',
      failure: result.kind,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
    };
  }
}
