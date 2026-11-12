import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BreakerDecision,
  BreakerOutcome,
  EndpointCircuit,
} from '../circuit-breaker.js';
import type { DeliveryJob } from '../dispatch/delivery-publisher.js';
import { generateEndpointSecret } from '../endpoint-secret.js';
import type { HttpFailureKind, HttpResult } from '../safe-http-client.js';
import { SignatureService } from '../signature-service.js';
import { DeliveryAttempt } from './delivery-attempt.js';
import {
  type EndpointTarget,
  EndpointTargetLookup,
} from './endpoint-target-lookup.js';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

class FakeLookup extends EndpointTargetLookup {
  readonly targets = new Map<string, EndpointTarget>();
  readonly asked: { tenantId: string; endpointId: string }[] = [];
  failWith?: Error;

  async find(
    tenantId: string,
    endpointId: string,
  ): Promise<EndpointTarget | null> {
    this.asked.push({ tenantId, endpointId });
    if (this.failWith) throw this.failWith;
    return this.targets.get(`${tenantId}/${endpointId}`) ?? null;
  }
}

class FakeCircuit implements EndpointCircuit {
  decision: BreakerDecision = { kind: 'allow' };
  readonly asked: string[] = [];
  readonly recorded: {
    endpointId: string;
    outcome: BreakerOutcome;
    probeToken?: string;
  }[] = [];

  async allow(endpointId: string): Promise<BreakerDecision> {
    this.asked.push(endpointId);
    return this.decision;
  }

  async record(
    endpointId: string,
    outcome: BreakerOutcome,
    probeToken?: string,
  ): Promise<void> {
    this.recorded.push({ endpointId, outcome, probeToken });
  }
}

class RecordingClient {
  readonly sent: Sent[] = [];
  result: HttpResult = {
    outcome: 'success',
    status: 200,
    latencyMs: 12,
    snippet: 'ok',
  };

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<HttpResult> {
    this.sent.push({ url, headers, body });
    return this.result;
  }
}

const job: DeliveryJob = {
  deliveryId: 'delivery-1',
  eventId: 'event-1',
  tenantId: 'tenant-1',
  endpointId: 'endpoint-1',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42', nested: { a: [1, 2] } },
};

describe('DeliveryAttempt', () => {
  const secret = generateEndpointSecret();
  const signatures = new SignatureService();
  let lookup: FakeLookup;
  let client: RecordingClient;
  let breaker: FakeCircuit;
  let clock: Date;
  let delivery: DeliveryAttempt;

  beforeEach(() => {
    lookup = new FakeLookup();
    lookup.targets.set('tenant-1/endpoint-1', {
      url: 'https://hooks.acme.test/in',
      signingSecret: secret,
      status: 'active',
    });
    client = new RecordingClient();
    breaker = new FakeCircuit();
    clock = new Date('2026-11-11T12:00:00.500Z');
    delivery = new DeliveryAttempt({
      lookup,
      client,
      breaker,
      signatures,
      now: () => clock,
    });
  });

  function onlySent(): Sent {
    expect(client.sent).toHaveLength(1);
    return client.sent[0] as Sent;
  }

  it('posts to the endpoint’s url', async () => {
    await delivery.attempt(job);

    expect(onlySent().url).toBe('https://hooks.acme.test/in');
  });

  it('sends the event as a JSON envelope', async () => {
    await delivery.attempt(job);

    const sent = onlySent();
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.body)).toEqual({
      id: 'event-1',
      type: 'invoice.paid',
      data: { invoice: 'INV-42', nested: { a: [1, 2] } },
    });
  });

  it('signs exactly the bytes it sends, so the receiver can verify them', async () => {
    await delivery.attempt(job);

    const { headers, body } = onlySent();
    expect(
      signatures.verify(
        headers['webhook-signature'] ?? '',
        headers['webhook-id'] ?? '',
        Number(headers['webhook-timestamp']),
        body,
        [secret],
        clock,
      ),
    ).toBe(true);
  });

  it('uses the delivery id as the webhook id and unix seconds as the timestamp', async () => {
    await delivery.attempt(job);

    const { headers } = onlySent();
    expect(headers['webhook-id']).toBe('delivery-1');
    expect(headers['webhook-timestamp']).toBe(
      String(Math.floor(clock.getTime() / 1000)),
    );
  });

  it('signs with the endpoint’s own secret, not another one', async () => {
    await delivery.attempt(job);

    const { headers, body } = onlySent();
    expect(
      signatures.verify(
        headers['webhook-signature'] ?? '',
        headers['webhook-id'] ?? '',
        Number(headers['webhook-timestamp']),
        body,
        [generateEndpointSecret()],
        clock,
      ),
    ).toBe(false);
  });

  it('keeps the webhook id but takes a fresh timestamp and signature on a later attempt', async () => {
    await delivery.attempt(job);
    clock = new Date('2026-11-12T08:00:00.000Z'); // about 20 hours later
    await delivery.attempt(job);

    const [first, second] = client.sent as [Sent, Sent];
    expect(second.headers['webhook-id']).toBe(first.headers['webhook-id']);
    expect(Number(second.headers['webhook-timestamp'])).toBe(
      Math.floor(clock.getTime() / 1000),
    );
    expect(second.headers['webhook-timestamp']).not.toBe(
      first.headers['webhook-timestamp'],
    );
    expect(second.headers['webhook-signature']).not.toBe(
      first.headers['webhook-signature'],
    );
    // The late attempt passes the receiver's 5-minute window at its own time.
    expect(
      signatures.verify(
        second.headers['webhook-signature'] ?? '',
        second.headers['webhook-id'] ?? '',
        Number(second.headers['webhook-timestamp']),
        second.body,
        [secret],
        clock,
      ),
    ).toBe(true);
  });

  it('looks the endpoint up with the job’s tenant and endpoint', async () => {
    await delivery.attempt(job);

    expect(lookup.asked).toEqual([
      { tenantId: 'tenant-1', endpointId: 'endpoint-1' },
    ]);
  });

  it('reports a 2xx as delivered, with the status and latency', async () => {
    client.result = {
      outcome: 'success',
      status: 204,
      latencyMs: 31,
      snippet: '',
    };

    expect(await delivery.attempt(job)).toEqual({
      kind: 'delivered',
      status: 204,
      latencyMs: 31,
      snippet: '',
    });
  });

  it('carries the response snippet of a delivered attempt', async () => {
    client.result = {
      outcome: 'success',
      status: 200,
      latencyMs: 4,
      snippet: 'received',
    };

    expect(await delivery.attempt(job)).toMatchObject({
      kind: 'delivered',
      snippet: 'received',
    });
  });

  it('carries the response snippet of a failed attempt', async () => {
    client.result = {
      outcome: 'failed',
      kind: 'http_error',
      status: 503,
      latencyMs: 9,
      snippet: 'overloaded',
    };

    expect(await delivery.attempt(job)).toMatchObject({
      kind: 'failed',
      snippet: 'overloaded',
    });
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
  ])('reports a %s result as a failed attempt of that kind', async (kind) => {
    client.result = {
      outcome: 'failed',
      kind,
      status: 503,
      latencyMs: 77,
      error: 'boom',
    };

    expect(await delivery.attempt(job)).toEqual({
      kind: 'failed',
      failure: kind,
      status: 503,
      error: 'boom',
      latencyMs: 77,
    });
  });

  it('does not call a missing endpoint', async () => {
    lookup.targets.clear();

    expect(await delivery.attempt(job)).toEqual({
      kind: 'skipped',
      reason: 'endpoint_missing',
    });
    expect(client.sent).toHaveLength(0);
  });

  it('does not call a disabled endpoint', async () => {
    lookup.targets.set('tenant-1/endpoint-1', {
      url: 'https://hooks.acme.test/in',
      signingSecret: secret,
      status: 'disabled',
    });

    expect(await delivery.attempt(job)).toEqual({
      kind: 'skipped',
      reason: 'endpoint_disabled',
    });
    expect(client.sent).toHaveLength(0);
  });

  it('lets a lookup error through and calls nothing', async () => {
    lookup.failWith = new Error('database is down');

    await expect(delivery.attempt(job)).rejects.toThrow('database is down');
    expect(client.sent).toHaveLength(0);
  });

  describe('the circuit breaker', () => {
    it('does not call an endpoint whose circuit is open, and defers the job', async () => {
      breaker.decision = { kind: 'deny' };

      expect(await delivery.attempt(job)).toEqual({
        kind: 'deferred',
        reason: 'circuit_open',
      });
      expect(client.sent).toHaveLength(0);
      expect(breaker.recorded).toEqual([]);
    });

    it('asks about the job’s endpoint', async () => {
      await delivery.attempt(job);

      expect(breaker.asked).toEqual(['endpoint-1']);
    });

    it('calls an allowed endpoint and records the result for it, with no token', async () => {
      await delivery.attempt(job);

      expect(client.sent).toHaveLength(1);
      expect(breaker.recorded).toEqual([
        { endpointId: 'endpoint-1', outcome: 'success', probeToken: undefined },
      ]);
    });

    it('calls the endpoint as the probe and records the result with the probe’s token', async () => {
      breaker.decision = { kind: 'probe', token: 'token-1' };
      client.result = { outcome: 'failed', kind: 'timeout', latencyMs: 10_000 };

      await delivery.attempt(job);

      expect(client.sent).toHaveLength(1);
      expect(breaker.recorded).toEqual([
        { endpointId: 'endpoint-1', outcome: 'failure', probeToken: 'token-1' },
      ]);
    });

    it.each<{ name: string; result: HttpResult; outcome: BreakerOutcome }>([
      {
        name: 'a 503',
        result: {
          outcome: 'failed',
          kind: 'http_error',
          status: 503,
          latencyMs: 5,
        },
        outcome: 'failure',
      },
      {
        name: 'a 429',
        result: {
          outcome: 'failed',
          kind: 'http_error',
          status: 429,
          latencyMs: 5,
        },
        outcome: 'failure',
      },
      {
        name: 'a timeout',
        result: { outcome: 'failed', kind: 'timeout', latencyMs: 10_000 },
        outcome: 'failure',
      },
      {
        name: 'an SSRF block',
        result: { outcome: 'failed', kind: 'ssrf_blocked', latencyMs: 1 },
        outcome: 'failure',
      },
      {
        name: 'a 2xx',
        result: { outcome: 'success', status: 204, latencyMs: 5, snippet: '' },
        outcome: 'success',
      },
      {
        name: 'a 404',
        result: {
          outcome: 'failed',
          kind: 'http_error',
          status: 404,
          latencyMs: 5,
        },
        outcome: 'success',
      },
      {
        name: 'a redirect',
        result: {
          outcome: 'failed',
          kind: 'redirect',
          status: 302,
          latencyMs: 5,
        },
        outcome: 'success',
      },
    ])('records $name as a breaker $outcome', async ({ result, outcome }) => {
      client.result = result;

      await delivery.attempt(job);

      expect(breaker.recorded.map((r) => r.outcome)).toEqual([outcome]);
    });

    it('does not consult the breaker for a missing endpoint', async () => {
      lookup.targets.clear();

      await delivery.attempt(job);

      expect(breaker.asked).toEqual([]);
      expect(breaker.recorded).toEqual([]);
    });

    it('does not consult the breaker for a disabled endpoint', async () => {
      lookup.targets.set('tenant-1/endpoint-1', {
        url: 'https://hooks.acme.test/in',
        signingSecret: secret,
        status: 'disabled',
      });

      await delivery.attempt(job);

      expect(breaker.asked).toEqual([]);
      expect(breaker.recorded).toEqual([]);
    });

    it('does not consult the breaker when the lookup fails', async () => {
      lookup.failWith = new Error('database is down');

      await expect(delivery.attempt(job)).rejects.toThrow('database is down');
      expect(breaker.asked).toEqual([]);
    });
  });
});
