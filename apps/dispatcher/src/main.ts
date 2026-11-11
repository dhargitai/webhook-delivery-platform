import { NestFactory } from '@nestjs/core';
import { DispatcherModule } from './dispatcher.module.js';

async function bootstrap() {
  // A standalone context: the dispatcher serves no HTTP. Creating it runs the
  // bootstrap hooks, which start consuming the dispatch queue.
  const app = await NestFactory.createApplicationContext(DispatcherModule);
  // SIGTERM and SIGINT then run the shutdown hooks: finish the events in
  // flight, then disconnect.
  app.enableShutdownHooks();
}
await bootstrap();
