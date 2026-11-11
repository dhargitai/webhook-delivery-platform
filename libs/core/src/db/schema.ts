import type { ColumnType, Generated } from 'kysely';

/** Postgres timestamptz: read as a Date, written as a Date or ISO string. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  created_at: Generated<Date>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  tenant_id: string;
  prefix: string;
  key_hash: string;
  created_at: Generated<Date>;
  revoked_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface EventsTable {
  event_id: string;
  tenant_id: string;
  idempotency_key: string | null;
  request_hash: string;
  event_type: string;
  // Any JSON value comes back. It is written as a JSON string because the pg
  // driver would turn a JS array into a Postgres array literal instead.
  payload: ColumnType<unknown, string, string>;
  created_at: Timestamp;
  published_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
}

/** Only the tables the code reads or writes so far; more arrive with their features. */
export interface Database {
  tenants: TenantsTable;
  api_keys: ApiKeysTable;
  events: EventsTable;
}
