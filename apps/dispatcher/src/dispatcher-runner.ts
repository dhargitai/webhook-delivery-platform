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
  Dispatcher,
  KyselySubscriptionLookup,
  LaneRouter,
} from '@wdp/core';
import {
  type BrokerConnection,
  ConfirmPublisher,
  Consumer,
  declareDispatchRetryTopology,
  declareTopology,
  MalformedMessageError,
  RequeueError,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { Kysely } from 'kysely';
import { BrokerDeliveryPublisher } from './broker-delivery-publisher.js';
import { BrokerDispatchRetryPublisher } from './broker-dispatch-retry-publisher.js';
import { dispatcherConfig } from './config/dispatcher.config.js';
import { DispatchFailureHandler } from './dispatch-failure-handler.js';
import { EventMessageHandler } from './event-message-handler.js';

/**
 * Owns the dispatcher's lifecycle. Nest runs each shutdown phase for the whole
 * app before the next, which is what makes the stop graceful: the consumer
 * stops first (onModuleDestroy), finishing the events it already holds, then
 * the dispatcher's channels close (beforeApplicationShutdown), and only then
 * does `@wdp/common` close the connections (onApplicationShutdown).
 */
@Injectable()
export class DispatcherRunner
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
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
    await declareDispatchRetryTopology(setup, {
      delayMs: this.config.retryDelayMs,
      namespace: this.config.brokerNamespace,
    });
    await setup.close();

    // Separate channels: the prefetch limit belongs to the consuming channel,
    // and publisher confirms to the publishing one.
    const publishChannel = await this.broker.createConfirmChannel();
    const consumeChannel = await this.broker.createChannel();
    this.channels.push(publishChannel, consumeChannel);

    // One publisher for jobs and for parked events: both need a confirm
    // before the message they belong to is acked.
    const confirmed = new ConfirmPublisher(publishChannel, {
      confirmTimeoutMs: this.config.confirmTimeoutMs,
    });
    const handler = new DispatchFailureHandler(
      new EventMessageHandler(
        new Dispatcher(
          new KyselySubscriptionLookup(this.db),
          new BrokerDeliveryPublisher(confirmed, names),
          new LaneRouter(this.config.laneCount),
        ),
      ),
      new BrokerDispatchRetryPublisher(
        confirmed,
        names,
        this.config.retryDelayMs,
      ),
      {
        maxAttempts: this.config.maxAttempts,
        onRetryScheduled: (message, nextAttempt, error) =>
          this.logger.warn('event dispatch failed, will be retried', {
            event_id: message.properties.correlationId,
            attempt: nextAttempt,
            retry_in_ms: this.config.retryDelayMs,
            error: errorText(error),
          }),
        onExhausted: (message, attempts, error) =>
          this.logger.error('event dispatch failed for good, dead-lettered', {
            event_id: message.properties.correlationId,
            attempt: attempts,
            error: errorText(error),
          }),
      },
    );

    this.consumer = await Consumer.start(
      consumeChannel,
      names.dispatchQueue,
      async (message) => {
        const jobs = await handler.handle(message);
        if (jobs !== undefined) {
          this.logger.debug('event dispatched', {
            event_id: message.properties.correlationId,
            jobs,
          });
        }
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

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.close()));
  }

  /**
   * Only a handler that threw reaches here, and the consumer rejected the
   * message for it: a malformed one is dead-lettered for good, and a
   * `RequeueError` went back to the queue. Failed dispatches are logged by the
   * handler's own callbacks.
   */
  private report(error: unknown, message: ConsumeMessage): void {
    const messageId = message.properties.messageId;
    if (error instanceof MalformedMessageError) {
      // Rejected, so it is in the dead-letter queue, but no retry could help.
      this.logger.warn('malformed event message dead-lettered', {
        message_id: messageId,
        reason: error.message,
      });
      return;
    }
    if (error instanceof RequeueError) {
      this.logger.error('could not park a failed event, requeued it', {
        message_id: messageId,
        error: errorText(error.cause ?? error),
      });
      return;
    }
    this.logger.error('unexpected error while handling an event', {
      message_id: messageId,
      error: errorText(error),
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
