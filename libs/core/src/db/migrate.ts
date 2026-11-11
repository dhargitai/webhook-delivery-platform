import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

// Same depth from src/db and from dist/db, so this holds for tests and builds.
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../migrations', import.meta.url),
);

/** Applies every pending migration. Safe to call repeatedly. */
export async function migrate(
  databaseUrl: string,
  dir: string = MIGRATIONS_DIR,
): Promise<void> {
  await runner({
    databaseUrl,
    dir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    // Stay quiet in tests; callers that want output can log around the call.
    log: () => {},
  });
}
