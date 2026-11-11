import { type Database, generateApiKey } from '@wdp/core';
import type { Kysely } from 'kysely';

export interface SeedResult {
  tenantId: string;
  /** False when a tenant of that name already existed and was reused. */
  created: boolean;
  /** The full key. Shown once: only its hash is stored. */
  apiKey: string;
}

export interface SeedOptions {
  tenantName: string;
}

/**
 * Creates a tenant (or finds the one of that name) and issues it a new API
 * key. Earlier keys stay valid, so running it again never locks anyone out.
 *
 * Tenant names are not unique in the schema, so two runs at the same moment
 * could both create one: this is a manual operator script, not a service.
 */
export async function seedTenant(
  db: Kysely<Database>,
  { tenantName }: SeedOptions,
): Promise<SeedResult> {
  const existing = await db
    .selectFrom('tenants')
    .select('id')
    .where('name', '=', tenantName)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();

  const tenantId =
    existing?.id ??
    (
      await db
        .insertInto('tenants')
        .values({ name: tenantName })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const { key, prefix, hash } = generateApiKey();
  await db
    .insertInto('api_keys')
    .values({ tenant_id: tenantId, prefix, key_hash: hash })
    .execute();

  return { tenantId, created: existing === undefined, apiKey: key };
}
