import { parseKek } from '@wdp/core';

const SEED_USAGE = 'usage: seed [--tenant <name>]';
const KEK_HINT =
  'Set it to the standard base64 of 32 random bytes, the same key the API and the worker use (generate one with `openssl rand -base64 32`).';

/** `DATABASE_URL`, or an error that says what to set. */
export function readDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the Postgres to use, for example postgres://wdp:wdp@localhost:5432/wdp',
    );
  }
  return url;
}

/** `SECRETS_KEK_V1`, decoded, or an error that says what to set. Never echoes the value. */
export function readKek(env: Record<string, string | undefined>): Buffer {
  const value = env.SECRETS_KEK_V1;
  if (value === undefined || value === '') {
    throw new Error(`SECRETS_KEK_V1 is not set. ${KEK_HINT}`);
  }
  try {
    return parseKek(value);
  } catch (error) {
    throw new Error(`SECRETS_KEK_V1 is not a valid key. ${KEK_HINT}`, {
      cause: error,
    });
  }
}

export interface SeedArgs {
  tenantName: string;
}

/** Reads `--tenant <name>` or `--tenant=<name>`; the tenant is called "demo" by default. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let tenantName = 'demo';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    let value: string | undefined;
    if (arg === '--tenant') {
      value = argv[++i];
    } else if (arg.startsWith('--tenant=')) {
      value = arg.slice('--tenant='.length);
    } else {
      throw new Error(`unexpected argument "${arg}"\n${SEED_USAGE}`);
    }
    if (value === undefined || value.trim() === '') {
      throw new Error(`--tenant needs a name\n${SEED_USAGE}`);
    }
    tenantName = value;
  }
  return { tenantName };
}
