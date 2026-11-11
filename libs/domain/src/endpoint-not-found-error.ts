import { NotFoundError } from './not-found-error.js';

/**
 * The endpoint does not exist or belongs to another tenant. The two cases are
 * deliberately indistinguishable, so ids cannot be probed across tenants.
 */
export class EndpointNotFoundError extends NotFoundError {
  readonly code = 'ENDPOINT_NOT_FOUND';

  constructor(endpointId: string) {
    super(`endpoint ${endpointId} not found`);
  }
}
