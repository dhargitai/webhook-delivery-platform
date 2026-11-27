import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  generateEndpointSecret,
  SECRET_ROTATION_OVERLAP_SECONDS,
  SecretCipher,
  secretAad,
  SsrfGuard,
} from '@wdp/core';
import {
  EndpointNotFoundError,
  SecretRotationInProgressError,
  UrlNotAllowedError,
} from '@wdp/domain';
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

/** A rotated secret, in the clear only here, and when the old one stops signing. */
export interface RotatedSecret {
  secret: string;
  previousExpiresAt: Date;
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

  /**
   * Gives the endpoint a new secret. The old one keeps signing through the
   * overlap, so the receiver can deploy the new one without dropping
   * deliveries; a second rotation during the overlap is refused.
   */
  async rotateSecret(tenantId: string, id: string): Promise<RotatedSecret> {
    const secret = generateEndpointSecret();
    const sealed = await this.cipher.seal(secret, secretAad(tenantId, id));
    const result = await this.endpoints.rotateSecret(
      tenantId,
      id,
      sealed,
      SECRET_ROTATION_OVERLAP_SECONDS,
    );
    switch (result.kind) {
      case 'rotated':
        return { secret, previousExpiresAt: result.previousExpiresAt };
      case 'in_progress':
        throw new SecretRotationInProgressError(result.until);
      case 'not_found':
        throw new EndpointNotFoundError(id);
    }
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
