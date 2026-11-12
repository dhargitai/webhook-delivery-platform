import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDatabase, type Database } from '@wdp/core';
import type { Kysely } from 'kysely';
import type { ConnectionModuleOptions } from './connection-module-options.js';
import { DATABASE } from './tokens.js';

@Injectable()
class DatabaseCloser implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * The Postgres pool as `DATABASE`, global so every module can inject it.
 *
 * It is closed in `onApplicationShutdown`, the last shutdown phase, so
 * anything still using it can finish in an earlier phase first.
 */
@Module({})
export class DatabaseModule {
  static forRootAsync<Deps extends unknown[]>(
    options: ConnectionModuleOptions<Deps>,
  ): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE,
          inject: options.inject,
          useFactory: (...deps: Deps) => {
            const logger = new Logger('Database');
            // A pool error is an idle connection that died; the pool replaces
            // it on demand, so it is only logged (see `createDatabase`).
            return createDatabase(options.url(...deps), {
              onPoolError: (error) =>
                logger.error('database pool error', error.stack),
            });
          },
        },
        DatabaseCloser,
      ],
      exports: [DATABASE],
    };
  }
}
