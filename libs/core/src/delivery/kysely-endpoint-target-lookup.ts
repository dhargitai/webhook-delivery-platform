import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import {
  type SealedSecret,
  type SecretOpener,
  secretAad,
} from '../secrets/secret-cipher.js';
import {
  type EndpointTarget,
  EndpointTargetLookup,
} from './endpoint-target-lookup.js';

export class KyselyEndpointTargetLookup extends EndpointTargetLookup {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretOpener,
  ) {
    super();
  }

  async find(
    tenantId: string,
    endpointId: string,
  ): Promise<EndpointTarget | null> {
    const row = await this.db
      .selectFrom('endpoints')
      .select([
        'url',
        'status',
        'rate_per_second',
        'burst',
        'secret_kek_id',
        'secret_wrapped_dek',
        'secret_iv',
        'secret_ciphertext',
        'secret_tag',
        'previous_secret_kek_id',
        'previous_secret_wrapped_dek',
        'previous_secret_iv',
        'previous_secret_ciphertext',
        'previous_secret_tag',
        // Decided by the database clock on every lookup, the one that set the
        // expiry: the secret cache holds only opened values, so it can never
        // stretch an overlap. Null (no previous secret) reads as not live.
        sql<boolean>`coalesce(previous_secret_expires_at > now(), false)`.as(
          'previous_live',
        ),
      ])
      .where('id', '=', endpointId)
      // The job carries the tenant, so another tenant's id reads as missing
      // and a secret can never cross tenants.
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!row) return null;
    const current = sealedSecret(
      row.secret_kek_id,
      row.secret_wrapped_dek,
      row.secret_iv,
      row.secret_ciphertext,
      row.secret_tag,
    );
    // A row the ops backfill has not sealed yet. Refused rather than read in
    // plaintext, so a skipped backfill shows at once instead of lingering.
    if (current === null) {
      throw new Error(`endpoint ${endpointId} has no sealed signing secret`);
    }
    const previous = row.previous_live
      ? sealedSecret(
          row.previous_secret_kek_id,
          row.previous_secret_wrapped_dek,
          row.previous_secret_iv,
          row.previous_secret_ciphertext,
          row.previous_secret_tag,
        )
      : null;
    // Both are bound to this tenant and endpoint: a sealed secret copied onto
    // another row fails to open instead of signing that endpoint's webhooks.
    // A previous secret that fails to open rejects like the current one.
    const aad = secretAad(tenantId, endpointId);
    const signingSecrets = await Promise.all(
      [current, ...(previous === null ? [] : [previous])].map((sealed) =>
        this.secrets.open(sealed, aad),
      ),
    );
    return {
      url: row.url,
      signingSecrets,
      status: row.status,
      // A null column is left out, so the limiter's default applies to it.
      rate: {
        ...(row.rate_per_second === null
          ? {}
          : { ratePerSecond: row.rate_per_second }),
        ...(row.burst === null ? {} : { burst: row.burst }),
      },
    };
  }
}

/** The five sealed columns as a `SealedSecret`, or null when they are unset. */
function sealedSecret(
  kekId: string | null,
  wrappedDek: Buffer | null,
  iv: Buffer | null,
  ciphertext: Buffer | null,
  tag: Buffer | null,
): SealedSecret | null {
  // The schema keeps them whole or absent; checking each one narrows the types.
  if (
    kekId === null ||
    wrappedDek === null ||
    iv === null ||
    ciphertext === null ||
    tag === null
  ) {
    return null;
  }
  return { kekId, wrappedDek, iv, ciphertext, tag };
}
