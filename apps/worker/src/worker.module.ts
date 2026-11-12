import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import {
  BrokerModule,
  DatabaseModule,
  MONGO,
  MongoModule,
  REDIS,
  RedisModule,
} from '@wdp/common';
import { CircuitBreaker, MongoAttemptLog } from '@wdp/core';
import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';
import { envSchema } from './config/env.schema.js';
import { workerConfig } from './config/worker.config.js';
import { StatusController } from './status.controller.js';
import { ATTEMPT_LOG, CIRCUIT_BREAKER } from './tokens.js';
import { WorkerRunner } from './worker-runner.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [workerConfig],
      validationSchema: envSchema,
    }),
    DatabaseModule.forRootAsync({
      inject: [workerConfig.KEY],
      url: (config: ConfigType<typeof workerConfig>) => config.databaseUrl,
    }),
    BrokerModule.forRootAsync({
      inject: [workerConfig.KEY],
      url: (config: ConfigType<typeof workerConfig>) => config.rabbitmqUrl,
    }),
    // The client connects lazily, on the first operation: the runner's
    // `ensureIndexes` at boot is what makes an unreachable server stop the
    // worker.
    MongoModule.forRootAsync({
      inject: [workerConfig.KEY],
      url: (config: ConfigType<typeof workerConfig>) => config.mongoUrl,
    }),
    // Not checked at boot: the breaker fails open, so the worker delivers
    // while Redis is unreachable, only without the circuit's protection.
    RedisModule.forRootAsync({
      inject: [workerConfig.KEY],
      url: (config: ConfigType<typeof workerConfig>) => config.redisUrl,
      // While Redis is unreachable, ioredis would hold each command through
      // up to 20 reconnect attempts (about 10 s, then up to 2 s apart) before
      // rejecting it, and every delivery would wait that long, twice, before
      // failing open. Instead a command is rejected at once while the client
      // is not connected, and one already sent when the connection drops is
      // rejected after a single reconnect attempt. The price: a delivery in
      // the moment before the first connection at boot fails open too.
      clientOptions: { enableOfflineQueue: false, maxRetriesPerRequest: 1 },
    }),
  ],
  controllers: [StatusController],
  providers: [
    {
      provide: ATTEMPT_LOG,
      inject: [MONGO, workerConfig.KEY],
      useFactory: (
        client: MongoClient,
        config: ConfigType<typeof workerConfig>,
      ) =>
        new MongoAttemptLog(client.db(config.mongoDb).collection('attempts')),
    },
    {
      provide: CIRCUIT_BREAKER,
      inject: [REDIS],
      // The PRD's thresholds and durations, in every environment: they are
      // not scaled with TIME_SCALE.
      useFactory: (redis: Redis) => new CircuitBreaker(redis),
    },
    WorkerRunner,
  ],
})
export class WorkerModule {}
