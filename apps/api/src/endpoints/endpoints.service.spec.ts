import { randomBytes } from 'node:crypto';
import {
  EnvKeyProvider,
  type HostResolver,
  type SealedSecret,
  SecretCipher,
  secretAad,
  SsrfGuard,
} from '@wdp/core';
import { EndpointNotFoundError, UrlNotAllowedError } from '@wdp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Endpoint,
  EndpointsRepository,
  type NewEndpoint,
} from './endpoints.repository.js';
import { EndpointsService } from './endpoints.service.js';

/** In-memory repository that applies the same tenant scoping as the real one. */
class FakeEndpointsRepository extends EndpointsRepository {
  readonly endpoints = new Map<string, Endpoint>();
  readonly subscriptions = new Map<string, string[]>();
  /** What the service handed over, by endpoint id. Never part of an `Endpoint`. */
  readonly secrets = new Map<string, SealedSecret>();
  private counter = 0;

  async create(
    tenantId: string,
    id: string,
    input: NewEndpoint,
    signingSecret: SealedSecret,
  ): Promise<Endpoint> {
    this.counter += 1;
    const endpoint: Endpoint = {
      id,
      tenantId,
      url: input.url,
      description: input.description,
      status: 'active',
      createdAt: new Date(2026, 0, this.counter),
    };
    this.endpoints.set(endpoint.id, endpoint);
    this.secrets.set(endpoint.id, signingSecret);
    return endpoint;
  }

  async list(tenantId: string): Promise<Endpoint[]> {
    return [...this.endpoints.values()].filter((e) => e.tenantId === tenantId);
  }

  async find(tenantId: string, id: string): Promise<Endpoint | null> {
    const endpoint = this.endpoints.get(id);
    return endpoint?.tenantId === tenantId ? endpoint : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if ((await this.find(tenantId, id)) === null) return false;
    this.endpoints.delete(id);
    this.subscriptions.delete(id);
    return true;
  }

  async replaceSubscriptions(
    tenantId: string,
    id: string,
    eventTypes: string[],
  ): Promise<boolean> {
    if ((await this.find(tenantId, id)) === null) return false;
    this.subscriptions.set(id, eventTypes);
    return true;
  }

  async listSubscriptions(
    tenantId: string,
    id: string,
  ): Promise<string[] | null> {
    if ((await this.find(tenantId, id)) === null) return null;
    return this.subscriptions.get(id) ?? [];
  }
}

/** A resolver that finds no host, so only literal IP hosts can be refused. */
const unresolvable: HostResolver = () =>
  Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('EndpointsService', () => {
  let repo: FakeEndpointsRepository;
  let service: EndpointsService;
  const cipher = new SecretCipher(
    new EnvKeyProvider({ kekId: 'v1', key: randomBytes(32) }),
  );

  beforeEach(() => {
    repo = new FakeEndpointsRepository();
    service = new EndpointsService(
      repo,
      new SsrfGuard({ resolve: unresolvable }),
      cipher,
    );
  });

  const input = { url: 'https://hooks.acme.test/in', description: null };
  const create = async (tenantId: string) =>
    (await service.create(tenantId, input)).endpoint;

  it('creates an active endpoint owned by the tenant', async () => {
    const { endpoint } = await service.create('tenant-a', input);

    expect(endpoint).toMatchObject({
      tenantId: 'tenant-a',
      url: 'https://hooks.acme.test/in',
      description: null,
      status: 'active',
    });
  });

  describe('target check', () => {
    it('refuses a URL whose host resolves to a blocked address, and stores nothing', async () => {
      const guarded = new EndpointsService(
        repo,
        new SsrfGuard({
          resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
        }),
        cipher,
      );

      const refused = guarded.create('tenant-a', input);

      await expect(refused).rejects.toBeInstanceOf(UrlNotAllowedError);
      await expect(refused).rejects.toMatchObject({
        reason:
          'hooks.acme.test resolves to 10.0.0.5, which is private network (RFC 1918)',
      });
      expect(repo.endpoints.size).toBe(0);
    });

    it('refuses a literal IP host that is not public', async () => {
      await expect(
        service.create('tenant-a', {
          url: 'https://169.254.169.254/',
          description: null,
        }),
      ).rejects.toMatchObject({ reason: '169.254.169.254 is link-local' });
      expect(repo.endpoints.size).toBe(0);
    });

    it('creates an endpoint whose host does not resolve yet', async () => {
      await expect(service.create('tenant-a', input)).resolves.toMatchObject({
        endpoint: { url: input.url },
      });
    });
  });

  describe('signing secret', () => {
    it('hands out the secret it stored, sealed, for the endpoint', async () => {
      const { endpoint, secret } = await service.create('tenant-a', input);
      const stored = repo.secrets.get(endpoint.id);

      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
      expect(stored?.ciphertext.includes(Buffer.from(secret))).toBe(false);
      await expect(
        stored && cipher.open(stored, secretAad('tenant-a', endpoint.id)),
      ).resolves.toBe(secret);
    });

    it('binds the stored secret to its own tenant and endpoint', async () => {
      const first = await service.create('tenant-a', input);
      const second = await service.create('tenant-a', input);
      const stored = repo.secrets.get(first.endpoint.id);
      if (stored === undefined) throw new Error('nothing stored');

      await expect(
        cipher.open(stored, secretAad('tenant-a', second.endpoint.id)),
      ).rejects.toThrow();
      await expect(
        cipher.open(stored, secretAad('tenant-b', first.endpoint.id)),
      ).rejects.toThrow();
    });

    it('creates every endpoint under a fresh UUID of its own', async () => {
      const first = await service.create('tenant-a', input);
      const second = await service.create('tenant-a', input);

      expect(first.endpoint.id).toMatch(UUID);
      expect(second.endpoint.id).toMatch(UUID);
      expect(first.endpoint.id).not.toBe(second.endpoint.id);
    });

    it('gives every endpoint its own secret', async () => {
      const first = await service.create('tenant-a', input);
      const second = await service.create('tenant-a', input);

      expect(first.secret).not.toBe(second.secret);
    });

    it('never exposes the secret when reading', async () => {
      const { endpoint, secret } = await service.create('tenant-a', input);

      const found = await service.get('tenant-a', endpoint.id);
      const listed = await service.list('tenant-a');

      expect(JSON.stringify([found, listed])).not.toContain(secret);
    });
  });

  it("lists only the tenant's own endpoints", async () => {
    const mine = await create('tenant-a');
    await create('tenant-b');

    expect(await service.list('tenant-a')).toEqual([mine]);
  });

  describe('reaching another tenant’s endpoint', () => {
    it.each([
      {
        name: 'get',
        act: (s: EndpointsService, id: string) => s.get('tenant-b', id),
      },
      {
        name: 'delete',
        act: (s: EndpointsService, id: string) => s.delete('tenant-b', id),
      },
      {
        name: 'replaceSubscriptions',
        act: (s: EndpointsService, id: string) =>
          s.replaceSubscriptions('tenant-b', id, ['x']),
      },
      {
        name: 'listSubscriptions',
        act: (s: EndpointsService, id: string) =>
          s.listSubscriptions('tenant-b', id),
      },
    ])(
      '$name throws not found and leaves the endpoint alone',
      async ({ act }) => {
        const owned = await create('tenant-a');
        await service.replaceSubscriptions('tenant-a', owned.id, [
          'invoice.paid',
        ]);

        await expect(act(service, owned.id)).rejects.toBeInstanceOf(
          EndpointNotFoundError,
        );

        expect(await service.get('tenant-a', owned.id)).toEqual(owned);
        expect(await service.listSubscriptions('tenant-a', owned.id)).toEqual([
          'invoice.paid',
        ]);
      },
    );
  });

  it('throws not found for an unknown endpoint id', async () => {
    await expect(service.get('tenant-a', 'nope')).rejects.toBeInstanceOf(
      EndpointNotFoundError,
    );
  });

  it('deletes an endpoint together with its subscriptions', async () => {
    const endpoint = await create('tenant-a');
    await service.replaceSubscriptions('tenant-a', endpoint.id, ['x']);

    await service.delete('tenant-a', endpoint.id);

    await expect(service.get('tenant-a', endpoint.id)).rejects.toBeInstanceOf(
      EndpointNotFoundError,
    );
    expect(repo.subscriptions.has(endpoint.id)).toBe(false);
  });

  describe('replaceSubscriptions', () => {
    it('stores each event type once, sorted', async () => {
      const endpoint = await create('tenant-a');

      const result = await service.replaceSubscriptions(
        'tenant-a',
        endpoint.id,
        ['invoice.paid', 'card.moved', 'invoice.paid'],
      );

      expect(result).toEqual(['card.moved', 'invoice.paid']);
      expect(repo.subscriptions.get(endpoint.id)).toEqual([
        'card.moved',
        'invoice.paid',
      ]);
    });

    it('replaces the previous set instead of adding to it', async () => {
      const endpoint = await create('tenant-a');
      await service.replaceSubscriptions('tenant-a', endpoint.id, ['a', 'b']);

      await service.replaceSubscriptions('tenant-a', endpoint.id, ['c']);

      expect(await service.listSubscriptions('tenant-a', endpoint.id)).toEqual([
        'c',
      ]);
    });

    it('clears every subscription when given an empty list', async () => {
      const endpoint = await create('tenant-a');
      await service.replaceSubscriptions('tenant-a', endpoint.id, ['a']);

      await service.replaceSubscriptions('tenant-a', endpoint.id, []);

      expect(await service.listSubscriptions('tenant-a', endpoint.id)).toEqual(
        [],
      );
    });
  });
});
