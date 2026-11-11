import { DomainError } from './domain-error.js';

/** A delivery was asked to do something its current state does not allow. */
export class IllegalDeliveryTransitionError extends DomainError {
  readonly code = 'ILLEGAL_DELIVERY_TRANSITION';

  constructor(state: string, action: string) {
    super(`cannot ${action} a delivery that is ${state}`);
  }
}
