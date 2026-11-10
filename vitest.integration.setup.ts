import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

let redis: StartedRedisContainer | undefined;

/**
 * One container per service for the whole integration run. Spec files share
 * it, so each spec isolates itself with unique keys instead of flushing.
 */
export async function setup(project: TestProject): Promise<void> {
  redis = await new RedisContainer('redis:8').start();
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await redis?.stop();
}
