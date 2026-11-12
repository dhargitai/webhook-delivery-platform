import { Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DatabaseModule, RedisModule } from '@wdp/common';
import { databaseConfig } from '../config/database.config.js';
import { redisConfig } from '../config/redis.config.js';

/**
 * The connections the API's modules share, both from `@wdp/common`: the
 * database as `DATABASE` and Redis as `REDIS`. Each is global, so any module
 * can inject it, and each closes itself when the app shuts down.
 */
@Module({
  imports: [
    DatabaseModule.forRootAsync({
      inject: [databaseConfig.KEY],
      url: (config: ConfigType<typeof databaseConfig>) => config.url,
    }),
    RedisModule.forRootAsync({
      inject: [redisConfig.KEY],
      url: (config: ConfigType<typeof redisConfig>) => config.url,
    }),
  ],
})
export class InfrastructureModule {}
