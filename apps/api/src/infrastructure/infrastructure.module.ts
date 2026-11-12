import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DatabaseModule } from '@wdp/common';
import { Redis } from 'ioredis';
import { databaseConfig } from '../config/database.config.js';
import { redisConfig } from '../config/redis.config.js';
import { REDIS } from './tokens.js';

/** Closes the Redis connection when the app shuts down. */
@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * The connections the API's modules share. The database comes from
 * `@wdp/common` (global `DATABASE`, which also closes it); Redis is the API's
 * own.
 */
@Global()
@Module({
  imports: [
    DatabaseModule.forRootAsync({
      inject: [databaseConfig.KEY],
      url: (config: ConfigType<typeof databaseConfig>) => config.url,
    }),
  ],
  providers: [
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) =>
        new Redis(config.url),
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class InfrastructureModule {}
