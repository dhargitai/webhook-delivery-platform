import { EndpointNotFoundError } from '@wdp/domain';
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
  private counter = 0;

  async create(tenantId: string, input: NewEndpoint): Promise<Endpoint> {
    this.counter += 1;
    const endpoint: Endpoint = {
      id: `ep-${this.counter}`,
      tenantId,
      url: input.url,
      description: input.description,
      status: 'active',
      createdAt: new Date(2026, 0, this.counter),
    };
    this.endpoints.set(endpoint.id, endpoint);
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

describe('EndpointsService', () => {
  let repo: FakeEndpointsRepository;
  let service: EndpointsService;

  beforeEach(() => {
    repo = new FakeEndpointsRepository();
    service = new EndpointsService(repo);
  });

  const input = { url: 'https://hooks.acme.test/in', description: null };

  it('creates an active endpoint owned by the tenant', async () => {
    const endpoint = await service.create('tenant-a', input);

    expect(endpoint).toMatchObject({
      tenantId: 'tenant-a',
      url: 'https://hooks.acme.test/in',
      description: null,
      status: 'active',
    });
  });

  it("lists only the tenant's own endpoints", async () => {
    const mine = await service.create('tenant-a', input);
    await service.create('tenant-b', input);

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
        const owned = await service.create('tenant-a', input);
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
    const endpoint = await service.create('tenant-a', input);
    await service.replaceSubscriptions('tenant-a', endpoint.id, ['x']);

    await service.delete('tenant-a', endpoint.id);

    await expect(service.get('tenant-a', endpoint.id)).rejects.toBeInstanceOf(
      EndpointNotFoundError,
    );
    expect(repo.subscriptions.has(endpoint.id)).toBe(false);
  });

  describe('replaceSubscriptions', () => {
    it('stores each event type once, sorted', async () => {
      const endpoint = await service.create('tenant-a', input);

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
      const endpoint = await service.create('tenant-a', input);
      await service.replaceSubscriptions('tenant-a', endpoint.id, ['a', 'b']);

      await service.replaceSubscriptions('tenant-a', endpoint.id, ['c']);

      expect(await service.listSubscriptions('tenant-a', endpoint.id)).toEqual([
        'c',
      ]);
    });

    it('clears every subscription when given an empty list', async () => {
      const endpoint = await service.create('tenant-a', input);
      await service.replaceSubscriptions('tenant-a', endpoint.id, ['a']);

      await service.replaceSubscriptions('tenant-a', endpoint.id, []);

      expect(await service.listSubscriptions('tenant-a', endpoint.id)).toEqual(
        [],
      );
    });
  });
});
