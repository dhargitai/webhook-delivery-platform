import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wdp/core';
import { type Kysely, sql } from 'kysely';
import { DATABASE } from '../infrastructure/tokens.js';
import {
  type Endpoint,
  EndpointsRepository,
  type NewEndpoint,
} from './endpoints.repository.js';

type EndpointRow = {
  id: string;
  tenant_id: string;
  url: string;
  description: string | null;
  status: 'active' | 'disabled';
  created_at: Date;
};

function toEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}

@Injectable()
export class KyselyEndpointsRepository extends EndpointsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {
    super();
  }

  async create(
    tenantId: string,
    input: NewEndpoint,
    signingSecret: string,
  ): Promise<Endpoint> {
    const row = await this.db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url: input.url,
        description: input.description,
        signing_secret: signingSecret,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEndpoint(row);
  }

  async list(tenantId: string): Promise<Endpoint[]> {
    const rows = await this.db
      .selectFrom('endpoints')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toEndpoint);
  }

  async find(tenantId: string, id: string): Promise<Endpoint | null> {
    const row = await this.db
      .selectFrom('endpoints')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toEndpoint(row) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    // Subscriptions go with it through ON DELETE CASCADE.
    const deleted = await this.db
      .deleteFrom('endpoints')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return deleted !== undefined;
  }

  async replaceSubscriptions(
    tenantId: string,
    id: string,
    eventTypes: string[],
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Locking the endpoint row serialises concurrent replaces of the same
      // endpoint. Without it, two transactions could both delete, then both
      // insert, and the loser would hit the unique constraint.
      const endpoint = await trx
        .selectFrom('endpoints')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (endpoint === undefined) {
        return false;
      }

      await trx
        .deleteFrom('subscriptions')
        .where('endpoint_id', '=', id)
        .execute();
      if (eventTypes.length > 0) {
        await trx
          .insertInto('subscriptions')
          .values(
            eventTypes.map((eventType) => ({
              tenant_id: tenantId,
              endpoint_id: id,
              event_type: eventType,
            })),
          )
          .execute();
      }
      return true;
    });
  }

  async listSubscriptions(
    tenantId: string,
    id: string,
  ): Promise<string[] | null> {
    if ((await this.find(tenantId, id)) === null) {
      return null;
    }
    const rows = await this.db
      .selectFrom('subscriptions')
      .select('event_type')
      .where('tenant_id', '=', tenantId)
      .where('endpoint_id', '=', id)
      // Byte order, so the result matches the service's sort whatever the
      // database collation is.
      .orderBy(sql`event_type collate "C"`)
      .execute();
    return rows.map((row) => row.event_type);
  }
}
