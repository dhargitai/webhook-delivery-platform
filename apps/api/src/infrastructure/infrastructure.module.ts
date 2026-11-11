import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { createDatabase, type Database } from '@wdp/core';
import { Redis } from 'ioredis';
import { Kysely } from 'kysely';
import { databaseConfig } from '../config/database.config.js';
import { redisConfig } from '../config/redis.config.js';
import { DATABASE, REDIS } from './tokens.js';

/** Closes the shared connections when the app shuts down. */
@Injectable()
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.db.destroy(), this.redis.quit()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [databaseConfig.KEY],
      useFactory: (config: ConfigType<typeof databaseConfig>) =>
        createDatabase(config.url),
    },
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) =>
        new Redis(config.url),
    },
    ConnectionCloser,
  ],
  exports: [DATABASE, REDIS],
})
export class InfrastructureModule {}
