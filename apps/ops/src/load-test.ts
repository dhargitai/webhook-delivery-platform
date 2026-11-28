import { createDatabase, LaneRouter } from '@wdp/core';
import { MongoClient } from 'mongodb';
import {
  describeError,
  parseLoadTestArgs,
  readDatabaseUrl,
  readLoadTestEnv,
} from './cli.js';
import { LoadApiClient } from './load-test/api-client.js';
import { systemClock } from './load-test/pacer.js';
import { formatMarkdown } from './load-test/report.js';
import { runLoadTest } from './load-test/run-load-test.js';

// Run as `node dist/load-test.js --label <name> [...]`, inside the Compose
// network: `docker compose run --rm load-test --label one-worker > run.json`.
// The JSON report goes to stdout and the readable table to stderr, so a
// redirect keeps only the data. Exits 1 when the run fails its verdict.
async function main(): Promise<void> {
  const args = parseLoadTestArgs(process.argv.slice(2));
  const env = readLoadTestEnv(process.env);
  const databaseUrl = readDatabaseUrl(process.env);

  const db = createDatabase(databaseUrl);
  const mongo = new MongoClient(env.mongoUrl);
  const api = new LoadApiClient(env.apiUrl);
  try {
    process.stderr.write(
      `Load test "${args.label}": ${args.tenants} tenants at ${args.ratePerTenant}/s, noisy at ${args.noisyRate}/s, for ${args.durationSeconds} s...\n`,
    );
    const report = await runLoadTest(
      {
        db,
        attempts: mongo.db(env.mongoDb).collection('attempts'),
        api,
        lanes: new LaneRouter(env.laneCount),
        clock: systemClock,
      },
      { ...args, receiverBaseUrl: env.receiverUrl },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`\n${formatMarkdown(report)}`);
    if (!report.verdict.pass) process.exitCode = 1;
  } finally {
    api.close();
    await mongo.close();
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Load test failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
