import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
    /** Server-level URL: specs create their own database on it. */
    postgresAdminUrl: string;
  }
}

let redis: StartedRedisContainer | undefined;
let postgres: StartedPostgreSqlContainer | undefined;

/**
 * One container per service for the whole integration run. Spec files share
 * them, so each spec isolates itself: unique keys in Redis, its own database
 * in Postgres.
 */
export async function setup(project: TestProject): Promise<void> {
  [redis, postgres] = await Promise.all([
    new RedisContainer('redis:8').start(),
    new PostgreSqlContainer('postgres:17-alpine').start(),
  ]);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('postgresAdminUrl', postgres.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await Promise.all([redis?.stop(), postgres?.stop()]);
}
