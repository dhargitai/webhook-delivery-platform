import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import type { ConnectionModuleOptions } from './connection-module-options.js';
import { REDIS } from './tokens.js';

export interface RedisModuleOptions<
  Deps extends unknown[],
> extends ConnectionModuleOptions<Deps> {
  /** Passed to the client as they are, the URL's settings aside. */
  clientOptions?: RedisOptions;
}

@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'ready') {
      // `quit` waits for the server's reply, so on a client that cannot
      // reach the server it would wait for ever. Such a client has nothing in
      // flight to finish, so it is dropped: `disconnect` cancels the pending
      // reconnect. Its status may stay 'reconnecting', as there is no socket
      // left whose close would end it, but it never tries again.
      this.redis.disconnect();
      return;
    }
    // `quit` resolves on the server's reply, a tick before the socket closes.
    const ended = new Promise<void>((resolve) => {
      this.redis.once('end', () => resolve());
    });
    await this.redis.quit();
    await ended;
  }
}

/**
 * The Redis client as `REDIS`, global so every module can inject it.
 *
 * The client connects in the background and keeps reconnecting while the
 * server is unreachable; each failure is logged rather than raised, so a
 * Redis outage is noticed by whoever uses the client, not here. It is closed
 * in `onApplicationShutdown`, the last shutdown phase.
 */
@Module({})
export class RedisModule {
  static forRootAsync<Deps extends unknown[]>(
    options: RedisModuleOptions<Deps>,
  ): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        {
          provide: REDIS,
          inject: options.inject,
          useFactory: (...deps: Deps) => {
            const logger = new Logger('Redis');
            const redis = new Redis(
              options.url(...deps),
              options.clientOptions ?? {},
            );
            // Without a listener, ioredis reports every failed connection
            // attempt as an unhandled error event.
            redis.on('error', (error: Error) =>
              logger.error('redis connection error', error.stack),
            );
            return redis;
          },
        },
        RedisCloser,
      ],
      exports: [REDIS],
    };
  }
}
