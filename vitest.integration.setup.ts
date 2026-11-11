import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RabbitMQContainer,
  type StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
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
    /** Specs isolate themselves with their own exchange and queue names. */
    rabbitUrl: string;
    /** Server-level URL: specs use their own database on it. */
    mongoUrl: string;
  }
}

let redis: StartedRedisContainer | undefined;
let postgres: StartedPostgreSqlContainer | undefined;
let rabbit: StartedRabbitMQContainer | undefined;
let mongo: StartedMongoDBContainer | undefined;

/**
 * One container per service for the whole integration run. Spec files share
 * them, so each spec isolates itself: unique keys in Redis, its own database
 * in Postgres, its own namespace of exchanges and queues in RabbitMQ, its
 * own database in MongoDB.
 */
export async function setup(project: TestProject): Promise<void> {
  [redis, postgres, rabbit, mongo] = await Promise.all([
    new RedisContainer('redis:8').start(),
    new PostgreSqlContainer('postgres:17-alpine').start(),
    // The module's 30 s default is too short for RabbitMQ on a busy machine.
    // Pinned to the same minor as docker-compose.yml (guarded by a unit spec).
    new RabbitMQContainer('rabbitmq:4.4').withStartupTimeout(120_000).start(),
    // Same major as docker-compose.yml. The module starts a one-node replica
    // set, so its connection string needs `directConnection` from the host.
    new MongoDBContainer('mongo:8').withStartupTimeout(120_000).start(),
  ]);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('postgresAdminUrl', postgres.getConnectionUri());
  project.provide('rabbitUrl', rabbit.getAmqpUrl());
  project.provide(
    'mongoUrl',
    `${mongo.getConnectionString()}?directConnection=true`,
  );
}

export async function teardown(): Promise<void> {
  await Promise.all([
    redis?.stop(),
    postgres?.stop(),
    rabbit?.stop(),
    mongo?.stop(),
  ]);
}
