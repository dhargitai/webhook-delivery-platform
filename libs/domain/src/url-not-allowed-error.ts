import { DomainError } from './domain-error.js';

/**
 * An endpoint URL is well formed but its target must never be called: the host
 * is, or resolves to, an address that is not public.
 */
export class UrlNotAllowedError extends DomainError {
  readonly code = 'URL_NOT_ALLOWED';

  constructor(
    /** Why, in words the developer can act on, e.g. "169.254.169.254 is link-local". */
    readonly reason: string,
  ) {
    super(`url not allowed: ${reason}`);
  }
}
