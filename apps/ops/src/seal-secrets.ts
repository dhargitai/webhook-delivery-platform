import {
  createDatabase,
  EnvKeyProvider,
  sealPlaintextSecrets,
  SecretCipher,
} from '@wdp/core';
import { readDatabaseUrl, readKek } from './cli.js';

// Run as `node dist/seal-secrets.js`, after the migrations. Idempotent: it
// seals only the endpoint secrets still stored in plaintext, and the Compose
// `migrate` one-shot runs it every time, before any service reads endpoints.
async function main(): Promise<void> {
  const databaseUrl = readDatabaseUrl(process.env);
  const cipher = new SecretCipher(
    new EnvKeyProvider({ kekId: 'v1', key: readKek(process.env) }),
  );

  const db = createDatabase(databaseUrl);
  try {
    const sealed = await sealPlaintextSecrets(db, cipher);
    process.stdout.write(
      sealed === 0
        ? 'No plaintext endpoint secrets left.\n'
        : `Sealed ${sealed} endpoint secret${sealed === 1 ? '' : 's'}.\n`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seal failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
