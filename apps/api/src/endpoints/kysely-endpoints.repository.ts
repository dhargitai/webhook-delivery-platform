import { Inject, Injectable } from '@nestjs/common';
import type { Database, SealedSecret } from '@wdp/core';
import { type Kysely, sql } from 'kysely';
import { DATABASE } from '@wdp/common';
import {
  type Endpoint,
  EndpointsRepository,
  type NewEndpoint,
  type SecretRotation,
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
    id: string,
    input: NewEndpoint,
    signingSecret: SealedSecret,
  ): Promise<Endpoint> {
    const row = await this.db
      .insertInto('endpoints')
      .values({
        id,
        tenant_id: tenantId,
        url: input.url,
        description: input.description,
        // Sealed only; the plaintext column is left NULL.
        secret_kek_id: signingSecret.kekId,
        secret_wrapped_dek: signingSecret.wrappedDek,
        secret_iv: signingSecret.iv,
        secret_ciphertext: signingSecret.ciphertext,
        secret_tag: signingSecret.tag,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEndpoint(row);
  }

  async rotateSecret(
    tenantId: string,
    id: string,
    next: SealedSecret,
    overlapSeconds: number,
  ): Promise<SecretRotation> {
    // One statement: the SET reads the row as it was, so the current secret
    // moves to the previous columns without being opened (its AAD names the
    // endpoint, not the slot). A concurrent rotation waits on the row lock,
    // then re-checks the WHERE against this one's result and is refused.
    const rotated = await this.db
      .updateTable('endpoints')
      .set((eb) => ({
        previous_secret_kek_id: eb.ref('secret_kek_id'),
        previous_secret_wrapped_dek: eb.ref('secret_wrapped_dek'),
        previous_secret_iv: eb.ref('secret_iv'),
        previous_secret_ciphertext: eb.ref('secret_ciphertext'),
        previous_secret_tag: eb.ref('secret_tag'),
        previous_secret_expires_at: sql<Date>`now() + make_interval(secs => ${overlapSeconds})`,
        secret_kek_id: next.kekId,
        secret_wrapped_dek: next.wrappedDek,
        secret_iv: next.iv,
        secret_ciphertext: next.ciphertext,
        secret_tag: next.tag,
      }))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('previous_secret_expires_at', 'is', null),
          eb('previous_secret_expires_at', '<=', sql<Date>`now()`),
        ]),
      )
      .returning('previous_secret_expires_at')
      .executeTakeFirst();
    if (rotated?.previous_secret_expires_at) {
      return {
        kind: 'rotated',
        previousExpiresAt: rotated.previous_secret_expires_at,
      };
    }
    // Nothing updated: either there is no such endpoint for this tenant, or
    // an earlier rotation's overlap still runs.
    const existing = await this.db
      .selectFrom('endpoints')
      .select('previous_secret_expires_at')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing?.previous_secret_expires_at) {
      return { kind: 'not_found' };
    }
    return { kind: 'in_progress', until: existing.previous_secret_expires_at };
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
