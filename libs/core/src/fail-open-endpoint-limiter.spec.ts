import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AcquireResult,
  EndpointRate,
  EndpointSlots,
  Permit,
} from './endpoint-limiter.js';
import { FailOpenEndpointLimiter } from './fail-open-endpoint-limiter.js';

class FakeSlots implements EndpointSlots {
  result: AcquireResult = {
    kind: 'permit',
    permit: { endpointId: 'endpoint-1', token: 'token-1' },
  };
  failWith?: Error;
  readonly acquired: { endpointId: string; rate?: Partial<EndpointRate> }[] =
    [];
  readonly released: Permit[] = [];

  async acquire(
    endpointId: string,
    rate?: Partial<EndpointRate>,
  ): Promise<AcquireResult> {
    if (this.failWith) throw this.failWith;
    this.acquired.push({ endpointId, rate });
    return this.result;
  }

  async release(permit: Permit): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.released.push(permit);
  }
}

interface Reported {
  error: unknown;
  context: { operation: 'acquire' | 'release'; endpointId: string };
}

describe('FailOpenEndpointLimiter', () => {
  let inner: FakeSlots;
  let reported: Reported[];
  let limiter: FailOpenEndpointLimiter;

  beforeEach(() => {
    inner = new FakeSlots();
    reported = [];
    limiter = new FailOpenEndpointLimiter(inner, (error, context) =>
      reported.push({ error, context }),
    );
  });

  it.each<AcquireResult>([
    {
      kind: 'permit',
      permit: { endpointId: 'endpoint-1', token: 'token-1' },
    },
    { kind: 'denied', reason: 'concurrency_cap' },
    { kind: 'denied', reason: 'rate_limited' },
  ])('passes a $kind result through, $reason', async (result) => {
    inner.result = result;

    expect(await limiter.acquire('endpoint-1')).toEqual(result);
  });

  it('passes the endpoint and its rate to acquire, and the permit to release', async () => {
    const permit = { endpointId: 'endpoint-2', token: 'token-2' };

    await limiter.acquire('endpoint-2', { burst: 3 });
    await limiter.release(permit);

    expect(inner.acquired).toEqual([
      { endpointId: 'endpoint-2', rate: { burst: 3 } },
    ]);
    expect(inner.released).toEqual([permit]);
  });

  it('lets the call start when the limiter cannot decide, and reports why', async () => {
    inner.failWith = new Error('redis down');

    expect(await limiter.acquire('endpoint-1')).toEqual({
      kind: 'permit',
      permit: { endpointId: 'endpoint-1', token: expect.any(String) },
    });
    expect(reported).toEqual([
      {
        error: inner.failWith,
        context: { operation: 'acquire', endpointId: 'endpoint-1' },
      },
    ]);
  });

  it('carries on when a permit cannot be released, and reports why', async () => {
    inner.failWith = new Error('redis down');

    await expect(
      limiter.release({ endpointId: 'endpoint-1', token: 'token-1' }),
    ).resolves.toBeUndefined();
    expect(reported).toEqual([
      {
        error: inner.failWith,
        context: { operation: 'release', endpointId: 'endpoint-1' },
      },
    ]);
  });

  it('reports nothing while the limiter works', async () => {
    inner.result = { kind: 'denied', reason: 'rate_limited' };

    await limiter.acquire('endpoint-1');
    await limiter.release({ endpointId: 'endpoint-1', token: 'token-1' });

    expect(reported).toEqual([]);
  });
});
