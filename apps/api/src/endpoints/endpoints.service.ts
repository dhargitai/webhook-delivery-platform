import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  generateEndpointSecret,
  SecretCipher,
  secretAad,
  SsrfGuard,
} from '@wdp/core';
import { EndpointNotFoundError, UrlNotAllowedError } from '@wdp/domain';
import {
  type Endpoint,
  EndpointsRepository,
  type NewEndpoint,
} from './endpoints.repository.js';

/** A new endpoint with its signing secret, which exists in the clear only here. */
export interface CreatedEndpoint {
  endpoint: Endpoint;
  secret: string;
}

@Injectable()
export class EndpointsService {
  constructor(
    private readonly endpoints: EndpointsRepository,
    private readonly guard: SsrfGuard,
    private readonly cipher: SecretCipher,
  ) {}

  /**
   * Refuses a target the worker would never call, so the developer hears why
   * now instead of watching every delivery fail. Advisory only: DNS can change
   * later, and the worker checks every connection again.
   */
  async create(tenantId: string, input: NewEndpoint): Promise<CreatedEndpoint> {
    const refusal = await this.guard.refusalReason(input.url);
    if (refusal !== undefined) {
      throw new UrlNotAllowedError(refusal);
    }
    // The id is chosen here, before the insert, because the sealed secret is
    // bound to it: a ciphertext moved onto another row no longer opens.
    const id = randomUUID();
    const secret = generateEndpointSecret();
    const sealed = await this.cipher.seal(secret, secretAad(tenantId, id));
    const endpoint = await this.endpoints.create(tenantId, id, input, sealed);
    return { endpoint, secret };
  }

  list(tenantId: string): Promise<Endpoint[]> {
    return this.endpoints.list(tenantId);
  }

  async get(tenantId: string, id: string): Promise<Endpoint> {
    const endpoint = await this.endpoints.find(tenantId, id);
    if (endpoint === null) {
      throw new EndpointNotFoundError(id);
    }
    return endpoint;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    if (!(await this.endpoints.delete(tenantId, id))) {
      throw new EndpointNotFoundError(id);
    }
  }

  /** The subscription set is a set: duplicates collapse, and the order is fixed. */
  async replaceSubscriptions(
    tenantId: string,
    id: string,
    eventTypes: string[],
  ): Promise<string[]> {
    const unique = [...new Set(eventTypes)].sort();
    if (!(await this.endpoints.replaceSubscriptions(tenantId, id, unique))) {
      throw new EndpointNotFoundError(id);
    }
    return unique;
  }

  async listSubscriptions(tenantId: string, id: string): Promise<string[]> {
    const eventTypes = await this.endpoints.listSubscriptions(tenantId, id);
    if (eventTypes === null) {
      throw new EndpointNotFoundError(id);
    }
    return eventTypes;
  }
}
