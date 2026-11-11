import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request.js';

/** The id of the tenant that owns the API key of the current request. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const { tenantId } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    if (tenantId === undefined) {
      // The global ApiKeyGuard always runs first, so reaching this is a wiring bug.
      throw new Error('CurrentTenant used on a route without authentication');
    }
    return tenantId;
  },
);
