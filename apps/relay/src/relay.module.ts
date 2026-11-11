import { Logger, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { createDatabase } from '@wdp/core';
import { BrokerConnection } from '@wdp/messaging';
import { envSchema } from './config/env.schema.js';
import { relayConfig } from './config/relay.config.js';
import { RelayRunner } from './relay-runner.js';
import { BROKER, DATABASE } from './tokens.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [relayConfig],
      validationSchema: envSchema,
    }),
  ],
  providers: [
    {
      provide: DATABASE,
      inject: [relayConfig.KEY],
      useFactory: (config: ConfigType<typeof relayConfig>) => {
        const logger = new Logger('Database');
        return createDatabase(config.databaseUrl, {
          onPoolError: (error) =>
            logger.error('database pool error', error.stack),
        });
      },
    },
    {
      provide: BROKER,
      inject: [relayConfig.KEY],
      useFactory: (config: ConfigType<typeof relayConfig>) => {
        const logger = new Logger('Broker');
        return BrokerConnection.connect(config.rabbitmqUrl, (error) =>
          logger.error('broker connection error', error.stack),
        );
      },
    },
    RelayRunner,
  ],
})
export class RelayModule {}
