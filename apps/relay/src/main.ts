import { NestFactory } from '@nestjs/core';
import { RelayModule } from './relay.module.js';

async function bootstrap() {
  // A standalone context: the relay serves no HTTP. Creating it runs the
  // bootstrap hooks, which start the relay loop.
  const app = await NestFactory.createApplicationContext(RelayModule);
  // SIGTERM and SIGINT then run the shutdown hooks: finish the batch in flight, then disconnect.
  app.enableShutdownHooks();
}
await bootstrap();
