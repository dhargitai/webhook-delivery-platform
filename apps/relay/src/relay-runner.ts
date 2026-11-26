import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { BROKER, DATABASE } from '@wdp/common';
import {
  type Database,
  KyselyEventPurger,
  KyselyOutboxStore,
  OutboxRelay,
  PartialPublishError,
  RelayLoop,
} from '@wdp/core';
import {
  type BrokerConnection,
  ConfirmPublisher,
  declareEventTopology,
} from '@wdp/messaging';
import { Kysely } from 'kysely';
import { BrokerEventPublisher } from './broker-event-publisher.js';
import { relayConfig } from './config/relay.config.js';

/**
 * Owns the relay's lifecycle. Nest runs each shutdown phase for the whole app
 * before the next, which is what makes the stop graceful: the loop stops
 * first (onModuleDestroy), then the relay's channel closes
 * (beforeApplicationShutdown), and only then does `@wdp/common` close the
 * connections (onApplicationShutdown).
 *
 * It also runs the retention purge, a second loop on the same database: once
 * at boot, then every purge interval, a batch at a time until nothing is due.
 * It stops with the relay loop.
 */
@Injectable()
export class RelayRunner
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RelayRunner.name);
  private loop: RelayLoop | undefined;
  private purgeLoop: RelayLoop | undefined;
  private confirmChannel: { close(): Promise<void> } | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(BROKER) private readonly broker: BrokerConnection,
    @Inject(relayConfig.KEY)
    private readonly config: ConfigType<typeof relayConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Declared here so the relay works against a fresh broker.
    const setup = await this.broker.createChannel();
    const names = await declareEventTopology(setup, {
      namespace: this.config.brokerNamespace,
    });
    await setup.close();

    const channel = await this.broker.createConfirmChannel();
    this.confirmChannel = channel;
    const publisher = new BrokerEventPublisher(
      new ConfirmPublisher(channel, {
        confirmTimeoutMs: this.config.confirmTimeoutMs,
      }),
      names,
    );
    const relay = new OutboxRelay(new KyselyOutboxStore(this.db), publisher, {
      batchSize: this.config.batchSize,
    });

    this.loop = new RelayLoop(relay, {
      batchSize: this.config.batchSize,
      pollIntervalMs: this.config.pollIntervalMs,
      errorBackoffMs: this.config.errorBackoffMs,
      onError: (error) => this.report(error),
    });
    this.loop.start();
    this.logger.log('relay started', {
      batchSize: this.config.batchSize,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    this.purgeLoop = this.startPurge();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.loop?.stop(), this.purgeLoop?.stop()]);
    this.logger.log('relay stopped');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.confirmChannel?.close();
  }

  /**
   * The relay loop's contract is what a batched purge needs: a full batch
   * runs again at once, so a backlog drains, and a short one sleeps until the
   * next run.
   */
  private startPurge(): RelayLoop {
    const { purge } = this.config;
    const purger = new KyselyEventPurger(this.db, {
      retentionMs: purge.retentionMs,
      batchSize: purge.batchSize,
    });
    const loop = new RelayLoop(
      {
        runOnce: async () => {
          const count = await purger.purgeBatch();
          if (count > 0) {
            this.logger.log('events purged', { count });
          }
          return count;
        },
      },
      {
        batchSize: purge.batchSize,
        pollIntervalMs: purge.intervalMs,
        errorBackoffMs: purge.errorBackoffMs,
        onError: (error) =>
          this.logger.error(
            'event purge failed',
            error instanceof Error ? error.stack : String(error),
          ),
      },
    );
    loop.start();
    return loop;
  }

  private report(error: unknown): void {
    if (error instanceof PartialPublishError) {
      this.logger.warn('some events could not be published, will retry', {
        published: error.published,
        failedEventIds: error.failures.map((f) => f.eventId),
        firstError: String(error.failures[0]?.error),
      });
      return;
    }
    this.logger.error(
      'relay run failed',
      error instanceof Error ? error.stack : String(error),
    );
  }
}
