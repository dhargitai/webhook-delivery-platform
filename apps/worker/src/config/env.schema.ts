import { z } from 'zod';

/**
 * Every environment variable the worker reads. A missing variable without a
 * default, or an invalid value, stops it at boot instead of failing on the
 * first delivery.
 */
export const envSchema = z.object({
  // HTTP port of the status endpoint (the API uses 3000, the mock receiver
  // 4000).
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  // The MongoDB server and database the attempt log is written to.
  MONGO_URL: z.string().min(1),
  MONGO_DB: z.string().min(1).default('wdp'),
  // The Redis server that holds every endpoint's circuit breaker state,
  // shared by all workers.
  REDIS_URL: z.string().min(1),
  // Prefix of every exchange and queue. Services of one deployment share it.
  BROKER_NAMESPACE: z.string().min(1).default('wdp'),
  // Number of fresh-delivery lanes the worker consumes: 4 locally, 16 in the
  // design. Must match the dispatcher's.
  LANE_COUNT: z.coerce.number().int().positive().default(4),
  // Jobs handled at once per lane (PRD: fresh-lane prefetch 20).
  WORKER_PREFETCH: z.coerce.number().int().positive().default(20),
  // Retries handled at once, from the one `retry.ready` queue (PRD: 5, so
  // retries take at most 20% of a worker's concurrency).
  WORKER_RETRY_PREFETCH: z.coerce.number().int().positive().default(5),
  // Divides every retry delay: 1 in production, 30 for a demo, 1000 in tests.
  // Applied when the retry queues are declared, and part of their names.
  TIME_SCALE: z.coerce.number().positive().finite().default(1),
  // No retry delay is shorter than this many ms, however large the scale
  // (PRD: 500 for a demo, 20 in tests).
  RETRY_MIN_DELAY_MS: z.coerce.number().int().min(0).default(0),
  // Comma-separated hosts the SSRF guard lets through, over plain http and
  // any port. Development only (the Compose mock receiver); empty in
  // production. Same format as the API's.
  SSRF_ALLOW_HOSTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== ''),
    ),
});

export type Env = z.output<typeof envSchema>;

/** Parses `process.env`, applying defaults. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
