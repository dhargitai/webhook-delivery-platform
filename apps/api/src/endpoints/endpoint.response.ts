import type { Endpoint, EndpointStatus } from './endpoints.repository.js';
import type { CreatedEndpoint, RotatedSecret } from './endpoints.service.js';

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

/** The creation response is the one place the signing secret is ever shown. */
export interface CreatedEndpointResponse extends EndpointResponse {
  secret: string;
}

export function toCreatedEndpointResponse(
  created: CreatedEndpoint,
): CreatedEndpointResponse {
  return { ...toEndpointResponse(created.endpoint), secret: created.secret };
}

/** A rotation's response: the new secret, shown this once, and the overlap's end. */
export interface RotatedSecretResponse {
  secret: string;
  previous_secret_expires_at: string;
}

export function toRotatedSecretResponse(
  rotated: RotatedSecret,
): RotatedSecretResponse {
  return {
    secret: rotated.secret,
    previous_secret_expires_at: rotated.previousExpiresAt.toISOString(),
  };
}
