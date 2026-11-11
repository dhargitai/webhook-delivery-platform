import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { appConfig } from './config/app.config.js';
import { databaseConfig } from './config/database.config.js';
import { envSchema } from './config/env.schema.js';
import { ingestConfig } from './config/ingest.config.js';
import { redisConfig } from './config/redis.config.js';
import { EventsModule } from './events/events.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, redisConfig, ingestConfig],
      validationSchema: envSchema,
    }),
    InfrastructureModule,
    AuthModule,
    EventsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
