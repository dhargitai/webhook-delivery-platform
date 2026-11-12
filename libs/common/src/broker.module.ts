import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BrokerConnection } from '@wdp/messaging';
import type { ConnectionModuleOptions } from './connection-module-options.js';
import { BROKER } from './tokens.js';

@Injectable()
class BrokerCloser implements OnApplicationShutdown {
  constructor(@Inject(BROKER) private readonly broker: BrokerConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.broker.close();
  }
}

/**
 * The RabbitMQ connection as `BROKER`, global so every module can inject it.
 *
 * It is closed in `onApplicationShutdown`, the last shutdown phase, so the
 * channels opened on it must be closed in an earlier one.
 */
@Module({})
export class BrokerModule {
  static forRootAsync<Deps extends unknown[]>(
    options: ConnectionModuleOptions<Deps>,
  ): DynamicModule {
    return {
      module: BrokerModule,
      global: true,
      providers: [
        {
          provide: BROKER,
          inject: options.inject,
          useFactory: (...deps: Deps) => {
            const logger = new Logger('Broker');
            return BrokerConnection.connect(options.url(...deps), (error) =>
              logger.error('broker connection error', error.stack),
            );
          },
        },
        BrokerCloser,
      ],
      exports: [BROKER],
    };
  }
}
