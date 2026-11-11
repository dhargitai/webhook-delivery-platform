import type { Request } from 'express';

/** A request that has passed the ApiKeyGuard carries the tenant that owns the key. */
export interface AuthenticatedRequest extends Request {
  tenantId?: string;
}
