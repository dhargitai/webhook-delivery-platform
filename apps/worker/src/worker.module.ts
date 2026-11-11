import { Logger, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { createDatabase } from '@wdp/core';
import { BrokerConnection } from '@wdp/messaging';
import { envSchema } from './config/env.schema.js';
import { workerConfig } from './config/worker.config.js';
import { StatusController } from './status.controller.js';
import { BROKER, DATABASE } from './tokens.js';
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
      useFactory: (config: ConfigType<typeof workerConfig>) =>
        createDatabase(config.databaseUrl),
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
    WorkerRunner,
  ],
})
export class WorkerModule {}
