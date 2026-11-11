import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { SubscriptionLookup } from './subscription-lookup.js';

export class KyselySubscriptionLookup extends SubscriptionLookup {
  constructor(private readonly db: Kysely<Database>) {
    super();
  }

  async findActiveEndpointIds(
    tenantId: string,
    eventType: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('endpoints')
      .innerJoin('subscriptions', 'subscriptions.endpoint_id', 'endpoints.id')
      .select('endpoints.id')
      .where('endpoints.tenant_id', '=', tenantId)
      // Also filtered on the subscription, which lets the (tenant_id,
      // event_type) index do the work.
      .where('subscriptions.tenant_id', '=', tenantId)
      .where('subscriptions.event_type', '=', eventType)
      .where('endpoints.status', '=', 'active')
      .orderBy('endpoints.created_at')
      .orderBy('endpoints.id')
      .execute();
    return rows.map((row) => row.id);
  }
}
