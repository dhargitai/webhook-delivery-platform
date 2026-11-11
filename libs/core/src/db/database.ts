import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

export interface DatabaseOptions {
  maxConnections?: number;
  /**
   * Called when a connection that sits idle in the pool dies, for example
   * because Postgres restarted. The pool has already discarded it and opens a
   * new one on demand, so this is for logging, not for recovery.
   */
  onPoolError?: (error: Error) => void;
}

/** Call `destroy()` on the result at shutdown to close the pool. */
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, max: options.maxConnections });
  // An idle client has no query to fail, so the pool reports its death as an
  // `error` event. Node throws an event nobody listens to, which would take
  // the whole service down on a Postgres restart. A query that was running on
  // a dying connection still rejects to its caller as before.
  pool.on('error', (error) => options.onPoolError?.(error));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
