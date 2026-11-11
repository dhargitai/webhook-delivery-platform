import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../db/migrate.js';

export interface TestDatabase {
  /** Connection string of the migrated, otherwise empty database. */
  url: string;
  /** Drops the database. Close every connection to it first; drop waits for them to go. */
  drop(): Promise<void>;
}

async function waitForNoConnections(
  admin: pg.Client,
  database: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    if (Number(rows[0]?.n) === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `database ${database} still has open connections after ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Creates a uniquely named, fully migrated database on a shared Postgres
 * server. One per spec file keeps files independent without restarting the
 * container for each of them.
 */
export async function createTestDatabase(
  adminUrl: string,
): Promise<TestDatabase> {
  const name = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  await migrate(databaseUrl);

  return {
    url: databaseUrl,
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        // `pool.end()` resolves before its sockets have fully closed. Dropping
        // with FORCE meanwhile kills those connections, and each one then emits
        // an unhandled error. Wait for the backends to go away instead.
        await waitForNoConnections(client, name);
        await client.query(`DROP DATABASE "${name}"`);
      } finally {
        await client.end();
      }
    },
  };
}
