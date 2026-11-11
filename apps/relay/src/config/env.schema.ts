import { z } from 'zod';

/**
 * Every environment variable the relay reads. A missing variable without a
 * default stops it at boot instead of failing on the first batch.
 */
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  // Prefix of every exchange and queue. Services of one deployment share it.
  BROKER_NAMESPACE: z.string().min(1).default('wdp'),
  // PRD locked: 200 rows per batch, 100 ms poll, 5 s confirm timeout.
  RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  RELAY_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(100),
  RELAY_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Pause after a failed run, so a broker outage is not hammered.
  RELAY_ERROR_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
});

export type Env = z.output<typeof envSchema>;

/** Parses `process.env`, applying defaults. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
