import { z } from 'zod';

/**
 * Every environment variable the dispatcher reads. A missing variable without
 * a default stops it at boot instead of failing on the first event.
 */
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  // Prefix of every exchange and queue. Services of one deployment share it.
  BROKER_NAMESPACE: z.string().min(1).default('wdp'),
  // Number of fresh-delivery lanes: 4 locally, 16 in the design. Changing it
  // remaps endpoints to lanes, so the queues must be drained first.
  LANE_COUNT: z.coerce.number().int().positive().default(4),
  // Events handled at once (PRD: prefetch 20).
  DISPATCHER_PREFETCH: z.coerce.number().int().positive().default(20),
  DISPATCHER_CONFIRM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
});

export type Env = z.output<typeof envSchema>;

/** Parses `process.env`, applying defaults. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
