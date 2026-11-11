import { migrate } from '@wdp/core';
import { readDatabaseUrl } from './cli.js';

// Run as `node dist/migrate.js`. Idempotent: applies only what is pending.
try {
  await migrate(readDatabaseUrl(process.env));
  process.stdout.write('Migrations are up to date.\n');
} catch (error) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
