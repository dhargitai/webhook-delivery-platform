import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { MongoClient } from 'mongodb';
import type { ConnectionModuleOptions } from './connection-module-options.js';
import { MONGO } from './tokens.js';

@Injectable()
class MongoCloser implements OnApplicationShutdown {
  constructor(@Inject(MONGO) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}

/**
 * The MongoDB client as `MONGO`, global so every module can inject it.
 *
 * The client connects lazily, on its first operation, so an unreachable
 * server is noticed by whoever uses it first, not here. It is closed in
 * `onApplicationShutdown`, the last shutdown phase.
 */
@Module({})
export class MongoModule {
  static forRootAsync<Deps extends unknown[]>(
    options: ConnectionModuleOptions<Deps>,
  ): DynamicModule {
    return {
      module: MongoModule,
      global: true,
      providers: [
        {
          provide: MONGO,
          inject: options.inject,
          useFactory: (...deps: Deps) => new MongoClient(options.url(...deps)),
        },
        MongoCloser,
      ],
      exports: [MONGO],
    };
  }
}
