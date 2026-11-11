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
  Dispatcher,
  KyselySubscriptionLookup,
  LaneRouter,
} from '@wdp/core';
import {
  type BrokerConnection,
  ConfirmPublisher,
  Consumer,
  declareTopology,
  MalformedMessageError,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { Kysely } from 'kysely';
import { BrokerDeliveryPublisher } from './broker-delivery-publisher.js';
import { dispatcherConfig } from './config/dispatcher.config.js';
import { EventMessageHandler } from './event-message-handler.js';
import { BROKER, DATABASE } from './tokens.js';

/**
 * Owns the dispatcher's lifecycle. Nest runs shutdown hooks in a fixed order,
 * which is what makes the stop graceful: the consumer stops first
 * (onModuleDestroy), finishing the events it already holds, and only then are
 * the connections closed (onApplicationShutdown).
 */
@Injectable()
export class DispatcherRunner
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(DispatcherRunner.name);
  private consumer: Consumer | undefined;
  private readonly channels: { close(): Promise<void> }[] = [];

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(BROKER) private readonly broker: BrokerConnection,
    @Inject(dispatcherConfig.KEY)
    private readonly config: ConfigType<typeof dispatcherConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Declared here so the dispatcher works against a fresh broker.
    const setup = await this.broker.createChannel();
    const names = await declareTopology(setup, {
      laneCount: this.config.laneCount,
      namespace: this.config.brokerNamespace,
    });
    await setup.close();

    // Separate channels: the prefetch limit belongs to the consuming channel,
    // and publisher confirms to the publishing one.
    const publishChannel = await this.broker.createConfirmChannel();
    const consumeChannel = await this.broker.createChannel();
    this.channels.push(publishChannel, consumeChannel);

    const handler = new EventMessageHandler(
      new Dispatcher(
        new KyselySubscriptionLookup(this.db),
        new BrokerDeliveryPublisher(
          new ConfirmPublisher(publishChannel, {
            confirmTimeoutMs: this.config.confirmTimeoutMs,
          }),
          names,
        ),
        new LaneRouter(this.config.laneCount),
      ),
    );

    this.consumer = await Consumer.start(
      consumeChannel,
      names.dispatchQueue,
      async (message) => {
        const jobs = await handler.handle(message);
        this.logger.debug('event dispatched', {
          eventId: message.properties.correlationId,
          jobs,
        });
      },
      {
        prefetch: this.config.prefetch,
        onHandlerError: (error, message) => this.report(error, message),
      },
    );
    this.logger.log('dispatcher started', {
      laneCount: this.config.laneCount,
      prefetch: this.config.prefetch,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
    this.logger.log('dispatcher stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.close()));
    await this.broker.close();
    await this.db.destroy();
  }

  private report(error: unknown, message: ConsumeMessage): void {
    const messageId = message.properties.messageId;
    if (error instanceof MalformedMessageError) {
      // Rejected, so it is in the dead-letter queue, but no retry could help.
      this.logger.warn('malformed event message dead-lettered', {
        messageId,
        reason: error.message,
      });
      return;
    }
    // Rejected too: the event waits in the dead-letter queue for replay.
    this.logger.error('event dead-lettered after a failed dispatch', {
      messageId,
      error: error instanceof Error ? error.stack : String(error),
    });
  }
}
