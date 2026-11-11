import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { IngestRateLimiter } from '@wdp/core';
import { RateLimitExceededError } from '@wdp/domain';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

/**
 * Per-tenant ingest limit. Runs after the global ApiKeyGuard (which supplies
 * the tenant) and before body validation, so a flooding tenant is turned away
 * cheaply.
 */
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: IngestRateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { tenantId } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    if (tenantId === undefined) {
      throw new Error('IngestRateLimitGuard ran before authentication');
    }

    const result = await this.limiter.tryAcquire(tenantId);
    if (!result.allowed) {
      throw new RateLimitExceededError(result.retryAfterSeconds);
    }
    return true;
  }
}
