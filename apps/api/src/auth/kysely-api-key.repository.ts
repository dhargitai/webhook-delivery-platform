import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wdp/core';
import type { Kysely } from 'kysely';
import { DATABASE } from '../infrastructure/tokens.js';
import { type ApiKeyRecord, ApiKeyRepository } from './api-key.repository.js';

@Injectable()
export class KyselyApiKeyRepository extends ApiKeyRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {
    super();
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = await this.db
      .selectFrom('api_keys')
      .select(['tenant_id', 'key_hash', 'revoked_at'])
      .where('prefix', '=', prefix)
      .executeTakeFirst();
    return row
      ? {
          tenantId: row.tenant_id,
          keyHash: row.key_hash,
          revokedAt: row.revoked_at,
        }
      : null;
  }
}
