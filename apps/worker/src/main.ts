import { type ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { workerConfig } from './config/worker.config.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(WorkerModule);
  // SIGTERM and SIGINT then run the shutdown hooks. Consumers added later
  // finish their in-flight work there (Task 21).
  app.enableShutdownHooks();
  const { port } = app.get<ConfigType<typeof workerConfig>>(workerConfig.KEY);
  await app.listen(port);
}
await bootstrap();
