import { createDatabase } from '@wdp/core';
import { parseSeedArgs, readDatabaseUrl } from './cli.js';
import { seedTenant } from './seed-tenant.js';

// Run as `node dist/seed.js [--tenant <name>]`.
async function main(): Promise<void> {
  const databaseUrl = readDatabaseUrl(process.env);
  const options = parseSeedArgs(process.argv.slice(2));

  const db = createDatabase(databaseUrl);
  try {
    const { tenantId, created, apiKey } = await seedTenant(db, options);
    process.stdout.write(
      [
        `Tenant "${options.tenantName}" (${tenantId}) ${created ? 'created' : 'already existed'}.`,
        '',
        'API key, shown once. Store it now, only its hash is kept:',
        apiKey,
        '',
      ].join('\n'),
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
