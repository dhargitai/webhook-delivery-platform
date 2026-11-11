const SEED_USAGE = 'usage: seed [--tenant <name>]';

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
