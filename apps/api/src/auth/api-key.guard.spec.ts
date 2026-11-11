import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { generateApiKey } from '@wdp/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ApiKeyRecord, ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyGuard } from './api-key.guard.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

class FakeApiKeyRepository extends ApiKeyRepository {
  readonly records = new Map<string, ApiKeyRecord>();

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    return this.records.get(prefix) ?? null;
  }
}

function contextFor(authorization: string | undefined) {
  const request = {
    headers: authorization === undefined ? {} : { authorization },
  } as AuthenticatedRequest;
  return { request, context: new ExecutionContextHost([request]) };
}

describe('ApiKeyGuard', () => {
  let repo: FakeApiKeyRepository;
  let guard: ApiKeyGuard;

  beforeEach(() => {
    repo = new FakeApiKeyRepository();
    guard = new ApiKeyGuard(repo);
  });

  function issueKey(overrides: Partial<ApiKeyRecord> = {}) {
    const generated = generateApiKey();
    repo.records.set(generated.prefix, {
      tenantId: 'tenant-a',
      keyHash: generated.hash,
      revokedAt: null,
      ...overrides,
    });
    return generated;
  }

  it('admits a valid key and records the tenant on the request', async () => {
    const { key } = issueKey();
    const { request, context } = contextFor(`Bearer ${key}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
  });

  it('rejects a request without credentials', async () => {
    const { context } = contextFor(undefined);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    { name: 'a non-Bearer scheme', header: (k: string) => `Basic ${k}` },
    { name: 'a Bearer header with no key', header: () => 'Bearer ' },
    { name: 'a malformed key', header: () => 'Bearer whk_nope' },
  ])('rejects $name', async ({ header }) => {
    const { key } = issueKey();
    const { context } = contextFor(header(key));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a well-formed key whose prefix is unknown', async () => {
    const { key } = generateApiKey(); // never stored
    const { context } = contextFor(`Bearer ${key}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a revoked key', async () => {
    const { key } = issueKey({ revokedAt: new Date() });
    const { context } = contextFor(`Bearer ${key}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects the right prefix with the wrong secret', async () => {
    const { key } = issueKey();
    const forged = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
    const { context } = contextFor(`Bearer ${forged}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
