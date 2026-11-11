import { z } from 'zod';

/**
 * Every environment variable the worker reads. An invalid value stops it at
 * boot instead of failing later.
 */
export const envSchema = z.object({
  // HTTP port of the status endpoint (the API uses 3000, the mock receiver
  // 4000).
  PORT: z.coerce.number().int().positive().default(3001),
});

export type Env = z.output<typeof envSchema>;

/** Parses `process.env`, applying defaults. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
