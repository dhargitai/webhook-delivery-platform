import { DomainError } from './domain-error.js';

/** An Idempotency-Key was reused with a different request body. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}
