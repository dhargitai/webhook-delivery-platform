import { parseKek } from '@wdp/core';
import { z } from 'zod';

/**
 * Every environment variable the API reads. A missing variable without a
 * default stops the app at boot instead of failing on the first request.
 */
export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Base64 of the 32-byte key-encryption key that wraps every endpoint
  // secret's data key (AES-256-GCM). No default: a missing or malformed key
  // stops the app at boot. Generate one with `openssl rand -base64 32`.
  SECRETS_KEK_V1: z.string().transform((value, ctx) => {
    try {
      return parseKek(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'invalid KEK',
      });
      return z.NEVER;
    }
  }),
  // Per-tenant ingest limit (PRD: 100 events/s sustained, burst 200).
  INGEST_RATE_PER_SECOND: z.coerce.number().positive().default(100),
  INGEST_BURST: z.coerce.number().int().positive().default(200),
  // Comma-separated hosts exempt from the https and port rules for endpoint
  // URLs. Development only (the Compose mock receiver); empty in production.
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

/** Parses `process.env`, applying defaults. Config namespaces share this one reader. */
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
