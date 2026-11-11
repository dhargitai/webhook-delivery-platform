import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { parseApiKey, verifyApiKey } from '@wdp/core';
import { ApiKeyRepository } from './api-key.repository.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

const BEARER = /^Bearer (\S+)$/i;

/**
 * Global guard: every route needs a valid, unrevoked API key unless it opts
 * out. Authenticated requests carry `tenantId` for the handlers downstream.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawKey = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const parsed = rawKey === undefined ? null : parseApiKey(rawKey);
    if (rawKey === undefined || parsed === null) {
      throw this.unauthorized();
    }

    const record = await this.keys.findByPrefix(parsed.prefix);
    if (
      record === null ||
      record.revokedAt !== null ||
      !verifyApiKey(rawKey, record.keyHash)
    ) {
      throw this.unauthorized();
    }

    request.tenantId = record.tenantId;
    return true;
  }

  // One message for every cause, so a caller cannot tell an unknown key from a
  // revoked one or a wrong secret.
  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException('Invalid or missing API key');
  }
}
