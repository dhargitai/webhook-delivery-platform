import { DomainError } from './domain-error.js';

/**
 * An endpoint's secret was rotated and the previous one still signs for the
 * overlap. Another rotation now would drop that previous secret while
 * receivers may still rely on it, so it is refused until the overlap ends.
 */
export class SecretRotationInProgressError extends DomainError {
  readonly code = 'SECRET_ROTATION_IN_PROGRESS';

  constructor(
    /** When the previous secret stops signing and a rotation is allowed again. */
    readonly until: Date,
  ) {
    super(`the previous signing secret is in use until ${until.toISOString()}`);
  }
}
