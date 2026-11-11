import { Injectable } from '@nestjs/common';
import { generateEndpointSecret } from '@wdp/core';
import { EndpointNotFoundError } from '@wdp/domain';
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
  constructor(private readonly endpoints: EndpointsRepository) {}

  async create(tenantId: string, input: NewEndpoint): Promise<CreatedEndpoint> {
    const secret = generateEndpointSecret();
    const endpoint = await this.endpoints.create(tenantId, input, secret);
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
