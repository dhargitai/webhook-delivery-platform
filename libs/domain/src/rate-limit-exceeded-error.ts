import { DomainError } from './domain-error.js';

/** A tenant sent events faster than its ingest limit allows. */
export class RateLimitExceededError extends DomainError {
  readonly code = 'RATE_LIMIT_EXCEEDED';

  constructor(
    /** Whole seconds until a retry can succeed; becomes the Retry-After header. */
    readonly retryAfterSeconds: number,
  ) {
    super(`ingest rate limit exceeded, retry in ${retryAfterSeconds}s`);
  }
}
