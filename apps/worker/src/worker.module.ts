import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.schema.js';
import { workerConfig } from './config/worker.config.js';
import { StatusController } from './status.controller.js';

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
})
export class WorkerModule {}
