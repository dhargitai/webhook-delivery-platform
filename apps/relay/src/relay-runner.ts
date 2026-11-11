import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import {
  type Database,
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
import { BROKER, DATABASE } from './tokens.js';

/**
 * Owns the relay's lifecycle. Nest runs shutdown hooks in a fixed order, which
 * is what makes the stop graceful: the loop stops first (onModuleDestroy) and
 * only then are the connections closed (onApplicationShutdown).
 */
@Injectable()
export class RelayRunner
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(RelayRunner.name);
  private loop: RelayLoop | undefined;
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
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop();
    this.logger.log('relay stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.confirmChannel?.close();
    await this.broker.close();
    await this.db.destroy();
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
