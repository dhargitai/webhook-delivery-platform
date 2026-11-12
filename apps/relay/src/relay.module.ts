import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { BrokerModule, DatabaseModule } from '@wdp/common';
import { envSchema } from './config/env.schema.js';
import { relayConfig } from './config/relay.config.js';
import { RelayRunner } from './relay-runner.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [relayConfig],
      validationSchema: envSchema,
    }),
    DatabaseModule.forRootAsync({
      inject: [relayConfig.KEY],
      url: (config: ConfigType<typeof relayConfig>) => config.databaseUrl,
    }),
    BrokerModule.forRootAsync({
      inject: [relayConfig.KEY],
      url: (config: ConfigType<typeof relayConfig>) => config.rabbitmqUrl,
    }),
  ],
  providers: [RelayRunner],
})
export class RelayModule {}
