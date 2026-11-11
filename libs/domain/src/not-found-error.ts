import { DomainError } from './domain-error.js';

/** Base of every "no such resource for this tenant" failure; mapped to 404. */
export abstract class NotFoundError extends DomainError {}
