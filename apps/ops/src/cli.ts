import { parseKek } from '@wdp/core';
import { z } from 'zod';

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

const LOAD_TEST_USAGE =
  'usage: load-test --label <name> [--duration <s>] [--tenants <n>] [--rate <events/s>] [--fanout <n>] [--noisy-rate <events/s>] [--drain <s>]';

export interface LoadTestArgs {
  label: string;
  durationSeconds: number;
  tenants: number;
  ratePerTenant: number;
  fanout: number;
  noisyRate: number;
  drainSeconds: number;
}

// The flag of each numeric option. Zero and above pass here; whether zero is
// allowed is the scenario's and the pacer's call.
const NUMERIC_FLAGS = {
  '--duration': 'durationSeconds',
  '--tenants': 'tenants',
  '--rate': 'ratePerTenant',
  '--fanout': 'fanout',
  '--noisy-rate': 'noisyRate',
  '--drain': 'drainSeconds',
} as const satisfies Record<string, keyof LoadTestArgs>;

function isNumericFlag(flag: string): flag is keyof typeof NUMERIC_FLAGS {
  return Object.hasOwn(NUMERIC_FLAGS, flag);
}

/**
 * Reads `--flag <value>` or `--flag=value`. The defaults are the isolation
 * scenario of Task 30: 6 tenants at 90 events/s (540/s, each under the
 * 100/s ingest limit) and a noisy tenant trying 400/s, for 2 minutes.
 */
export function parseLoadTestArgs(argv: readonly string[]): LoadTestArgs {
  const usage = (problem: string) =>
    new Error(`${problem}\n${LOAD_TEST_USAGE}`);
  let label: string | undefined;
  const args: Omit<LoadTestArgs, 'label'> = {
    durationSeconds: 120,
    tenants: 6,
    ratePerTenant: 90,
    fanout: 1,
    noisyRate: 400,
    drainSeconds: 60,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (!flag.startsWith('--')) {
      throw usage(`unexpected argument "${arg}"`);
    }
    if (flag !== '--label' && !isNumericFlag(flag)) {
      throw usage(`unknown flag "${flag}"`);
    }
    if (value === undefined || value === '') {
      throw usage(`${flag} needs a value`);
    }
    if (flag === '--label') {
      label = value;
    } else {
      if (!/^\d+$/.test(value)) {
        throw usage(`${flag} must be a whole number, got "${value}"`);
      }
      args[NUMERIC_FLAGS[flag]] = Number(value);
    }
  }

  if (label === undefined) {
    throw usage('--label is required, so every run gets its own tenants');
  }
  return { label, ...args };
}

const loadTestEnvSchema = z.object({
  API_URL: z.url(),
  RECEIVER_URL: z.url(),
  MONGO_URL: z.string().min(1),
  MONGO_DB: z.string().min(1).default('wdp'),
  // Must be the dispatcher's, or victims are put on the wrong lanes.
  LANE_COUNT: z.coerce.number().int().positive().default(4),
});

export interface LoadTestEnv {
  apiUrl: string;
  /** The mock receiver as the worker reaches it. */
  receiverUrl: string;
  mongoUrl: string;
  mongoDb: string;
  laneCount: number;
}

/** The load test's settings, or an error naming each variable to fix. */
export function readLoadTestEnv(
  env: Record<string, string | undefined>,
): LoadTestEnv {
  // An empty value counts as unset, as it does for the other ops commands.
  const present = Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  );
  const result = loadTestEnvSchema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    throw new Error(
      `Invalid load-test environment (see .env.example):\n${problems.join('\n')}`,
    );
  }
  const { API_URL, RECEIVER_URL, MONGO_URL, MONGO_DB, LANE_COUNT } =
    result.data;
  return {
    apiUrl: API_URL,
    receiverUrl: RECEIVER_URL,
    mongoUrl: MONGO_URL,
    mongoDb: MONGO_DB,
    laneCount: LANE_COUNT,
  };
}

/**
 * A one-line reason for a failed command. A connection refused on every
 * address is an `AggregateError` with an empty message (what `pg` and Node's
 * dual-stack connect reject with), which would otherwise print nothing.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join('; ');
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code !== '' ? code : error.name;
}
