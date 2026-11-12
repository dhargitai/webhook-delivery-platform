import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { BrokerModule, DatabaseModule } from '@wdp/common';
import { dispatcherConfig } from './config/dispatcher.config.js';
import { envSchema } from './config/env.schema.js';
import { DispatcherRunner } from './dispatcher-runner.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [dispatcherConfig],
      validationSchema: envSchema,
    }),
    DatabaseModule.forRootAsync({
      inject: [dispatcherConfig.KEY],
      url: (config: ConfigType<typeof dispatcherConfig>) => config.databaseUrl,
    }),
    BrokerModule.forRootAsync({
      inject: [dispatcherConfig.KEY],
      url: (config: ConfigType<typeof dispatcherConfig>) => config.rabbitmqUrl,
    }),
  ],
  providers: [DispatcherRunner],
})
export class DispatcherModule {}
