import { Logger, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { createDatabase } from '@wdp/core';
import { BrokerConnection } from '@wdp/messaging';
import { dispatcherConfig } from './config/dispatcher.config.js';
import { envSchema } from './config/env.schema.js';
import { DispatcherRunner } from './dispatcher-runner.js';
import { BROKER, DATABASE } from './tokens.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [dispatcherConfig],
      validationSchema: envSchema,
    }),
  ],
  providers: [
    {
      provide: DATABASE,
      inject: [dispatcherConfig.KEY],
      useFactory: (config: ConfigType<typeof dispatcherConfig>) => {
        const logger = new Logger('Database');
        return createDatabase(config.databaseUrl, {
          onPoolError: (error) =>
            logger.error('database pool error', error.stack),
        });
      },
    },
    {
      provide: BROKER,
      inject: [dispatcherConfig.KEY],
      useFactory: (config: ConfigType<typeof dispatcherConfig>) => {
        const logger = new Logger('Broker');
        return BrokerConnection.connect(config.rabbitmqUrl, (error) =>
          logger.error('broker connection error', error.stack),
        );
      },
    },
    DispatcherRunner,
  ],
})
export class DispatcherModule {}
