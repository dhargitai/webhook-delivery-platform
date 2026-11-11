import { Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import {
  type Database,
  IdempotentIngest,
  IngestRateLimiter,
  KyselyEventStore,
  UuidV7EventIdGenerator,
} from '@wdp/core';
import { Redis } from 'ioredis';
import { Kysely } from 'kysely';
import { ingestConfig } from '../config/ingest.config.js';
import { DATABASE, REDIS } from '../infrastructure/tokens.js';
import { EventsController } from './events.controller.js';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard.js';

@Module({
  controllers: [EventsController],
  providers: [
    {
      provide: IdempotentIngest,
      inject: [DATABASE],
      useFactory: (db: Kysely<Database>) =>
        new IdempotentIngest(
          new KyselyEventStore(db),
          new UuidV7EventIdGenerator(),
        ),
    },
    {
      provide: IngestRateLimiter,
      inject: [REDIS, ingestConfig.KEY],
      useFactory: (redis: Redis, config: ConfigType<typeof ingestConfig>) =>
        new IngestRateLimiter(redis, config),
    },
    IngestRateLimitGuard,
  ],
})
export class EventsModule {}
