import type { Endpoint, EndpointStatus } from './endpoints.repository.js';

/** What the API returns for an endpoint: no tenant id, ISO dates, snake_case like the rest of the API. */
export interface EndpointResponse {
  id: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  created_at: string;
}

export function toEndpointResponse(endpoint: Endpoint): EndpointResponse {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    status: endpoint.status,
    created_at: endpoint.createdAt.toISOString(),
  };
}
