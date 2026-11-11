import { sql } from 'kysely';
import pg from 'pg';
import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  inject,
  it,
} from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { createDatabase, type Database } from './database.js';
import type { Kysely } from 'kysely';

describe('createDatabase (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database> | undefined;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
  });

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  afterAll(async () => {
    await testDb.drop();
  });

  /** What a Postgres restart does to the connections the pool keeps idle. */
  async function killAllConnections(): Promise<void> {
    const admin = new pg.Client({
      connectionString: inject('postgresAdminUrl'),
    });
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [new URL(testDb.url).pathname.slice(1)],
      );
    } finally {
      await admin.end();
    }
  }

  it('reports an idle connection that Postgres killed, and keeps working', async () => {
    const errors: Error[] = [];
    const reported = new Promise<void>((resolve) => {
      db = createDatabase(testDb.url, {
        onPoolError: (error) => {
          errors.push(error);
          resolve();
        },
      });
    });
    // One query leaves a client idle in the pool.
    await sql`SELECT 1`.execute(db as Kysely<Database>);

    await killAllConnections();
    await reported;

    expect(errors).toHaveLength(1);
    const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(
      db as Kysely<Database>,
    );
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('does not crash the process when nobody listens for the error', async () => {
    db = createDatabase(testDb.url);
    await sql`SELECT 1`.execute(db);

    await killAllConnections();
    // The pool learns about the dead connection from its socket, a moment
    // later. An error event nobody listens to is thrown, which fails the run.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
    expect(result.rows).toEqual([{ one: 1 }]);
  });
});
