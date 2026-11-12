import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { BrokerModule, DatabaseModule, MONGO, MongoModule } from '@wdp/common';
import { MongoAttemptLog } from '@wdp/core';
import type { MongoClient } from 'mongodb';
import { envSchema } from './config/env.schema.js';
import { workerConfig } from './config/worker.config.js';
import { StatusController } from './status.controller.js';
import { ATTEMPT_LOG } from './tokens.js';
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
    WorkerRunner,
  ],
})
export class WorkerModule {}
