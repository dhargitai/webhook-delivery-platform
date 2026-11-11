import { Logger, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { createDatabase, MongoAttemptLog } from '@wdp/core';
import { BrokerConnection } from '@wdp/messaging';
import { MongoClient } from 'mongodb';
import { envSchema } from './config/env.schema.js';
import { workerConfig } from './config/worker.config.js';
import { StatusController } from './status.controller.js';
import { ATTEMPT_LOG, BROKER, DATABASE, MONGO } from './tokens.js';
import { WorkerRunner } from './worker-runner.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [workerConfig],
      validationSchema: envSchema,
    }),
  ],
  controllers: [StatusController],
  providers: [
    {
      provide: DATABASE,
      inject: [workerConfig.KEY],
      useFactory: (config: ConfigType<typeof workerConfig>) => {
        const logger = new Logger('Database');
        return createDatabase(config.databaseUrl, {
          onPoolError: (error) =>
            logger.error('database pool error', error.stack),
        });
      },
    },
    {
      provide: BROKER,
      inject: [workerConfig.KEY],
      useFactory: (config: ConfigType<typeof workerConfig>) => {
        const logger = new Logger('Broker');
        return BrokerConnection.connect(config.rabbitmqUrl, (error) =>
          logger.error('broker connection error', error.stack),
        );
      },
    },
    {
      // Connects lazily, on the first operation: the runner's `ensureIndexes`
      // at boot is what makes an unreachable server stop the worker.
      provide: MONGO,
      inject: [workerConfig.KEY],
      useFactory: (config: ConfigType<typeof workerConfig>) =>
        new MongoClient(config.mongoUrl),
    },
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
