import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

export interface DatabaseOptions {
  maxConnections?: number;
}

/** Call `destroy()` on the result at shutdown to close the pool. */
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: options.maxConnections }),
    }),
  });
}
