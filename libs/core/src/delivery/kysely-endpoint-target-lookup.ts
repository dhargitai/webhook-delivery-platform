import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import {
  type EndpointTarget,
  EndpointTargetLookup,
} from './endpoint-target-lookup.js';

export class KyselyEndpointTargetLookup extends EndpointTargetLookup {
  constructor(private readonly db: Kysely<Database>) {
    super();
  }

  async find(
    tenantId: string,
    endpointId: string,
  ): Promise<EndpointTarget | null> {
    const row = await this.db
      .selectFrom('endpoints')
      .select(['url', 'signing_secret', 'status', 'rate_per_second', 'burst'])
      .where('id', '=', endpointId)
      // The job carries the tenant, so another tenant's id reads as missing
      // and a secret can never cross tenants.
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.signing_secret === null) {
      throw new Error(`endpoint ${endpointId} has no plaintext signing secret`);
    }
    return {
      url: row.url,
      signingSecret: row.signing_secret,
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
