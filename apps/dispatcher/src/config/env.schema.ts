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
  // A failed dispatch waits this long in the retry queue before the next try
  // (PRD: the 5 s short-delay tier). Part of the retry queue's name, so a new
  // value makes a new queue.
  DISPATCHER_RETRY_DELAY_MS: z.coerce.number().int().positive().default(5000),
  // Dispatch tries per event, the first included. With the default delay that
  // is about 45 s of pauses before the event is dead-lettered with its reason.
  DISPATCHER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
});

export type Env = z.output<typeof envSchema>;

/** Parses `process.env`, applying defaults. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
