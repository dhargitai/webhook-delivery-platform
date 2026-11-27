import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { type SecretOpener, secretAad } from '../secrets/secret-cipher.js';
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
      ])
      .where('id', '=', endpointId)
      // The job carries the tenant, so another tenant's id reads as missing
      // and a secret can never cross tenants.
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!row) return null;
    const {
      secret_kek_id,
      secret_wrapped_dek,
      secret_iv,
      secret_ciphertext,
      secret_tag,
    } = row;
    // A row the ops backfill has not sealed yet. Refused rather than read in
    // plaintext, so a skipped backfill shows at once instead of lingering.
    if (
      secret_kek_id === null ||
      secret_wrapped_dek === null ||
      secret_iv === null ||
      secret_ciphertext === null ||
      secret_tag === null
    ) {
      throw new Error(`endpoint ${endpointId} has no sealed signing secret`);
    }
    // Bound to this tenant and endpoint: a sealed secret copied onto another
    // row fails to open instead of signing that endpoint's webhooks.
    const signingSecret = await this.secrets.open(
      {
        kekId: secret_kek_id,
        wrappedDek: secret_wrapped_dek,
        iv: secret_iv,
        ciphertext: secret_ciphertext,
        tag: secret_tag,
      },
      secretAad(tenantId, endpointId),
    );
    return {
      url: row.url,
      signingSecret,
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
