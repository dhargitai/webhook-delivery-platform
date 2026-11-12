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
  type AttemptOutcome,
  type Database,
  DeliveryAttempt,
  KyselyEndpointTargetLookup,
  MAX_ATTEMPTS,
  type MongoAttemptLog,
  RetryPolicy,
  SafeHttpClient,
  SignatureService,
  SsrfGuard,
} from '@wdp/core';
import {
  type BrokerConnection,
  ConfirmPublisher,
  Consumer,
  declareRetryTopology,
  MalformedMessageError,
  RequeueError,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { Kysely } from 'kysely';
import { BrokerRetryPublisher } from './broker-retry-publisher.js';
import { workerConfig } from './config/worker.config.js';
import { JobMessageHandler } from './job-message-handler.js';
import { type RetryHandled, RetryHandler } from './retry-handler.js';
import { ATTEMPT_LOG } from './tokens.js';

/**
 * Owns the worker's lifecycle. Nest runs each shutdown phase for the whole app
 * before the next, which is what makes the stop graceful: the consumers stop
 * first (onModuleDestroy), finishing the jobs they already hold, then the
 * worker's channels close (beforeApplicationShutdown), and only then does
 * `@wdp/common` close the connections (onApplicationShutdown).
 */
@Injectable()
export class WorkerRunner
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly consumers: Consumer[] = [];
  private readonly channels: { close(): Promise<void> }[] = [];

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(BROKER) private readonly broker: BrokerConnection,
    @Inject(ATTEMPT_LOG) private readonly attemptLog: MongoAttemptLog,
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Before any consumer starts, so no attempt is logged ahead of its
    // indexes and an unreachable Mongo stops the worker at boot, not on the
    // first delivery.
    await this.attemptLog.ensureIndexes();

    // The retry queues' delays come from the policy, which is what makes a
    // retry always have a queue to go to. Declared here so the worker works
    // against a fresh broker.
    const policy = new RetryPolicy({
      timeScale: this.config.timeScale,
      minDelayMs: this.config.retryMinDelayMs,
    });
    const setup = await this.broker.createChannel();
    const names = await declareRetryTopology(setup, {
      laneCount: this.config.laneCount,
      retryDelaysMs: policy.delays(),
      parkDelayMs: policy.parkDelayMs,
      namespace: this.config.brokerNamespace,
    });
    await setup.close();

    // One guard supplies both checks: the connect-time lookup for names and
    // the host check for IP literals, which never reach the lookup.
    const guard = new SsrfGuard({ allowHosts: this.config.ssrfAllowHosts });
    // A failed attempt is logged, then its retry is published and confirmed,
    // and only then does the consumer ack (see `RetryHandler`).
    const retryChannel = await this.broker.createConfirmChannel();
    this.channels.push(retryChannel);
    const handler = new RetryHandler(
      new JobMessageHandler(
        new DeliveryAttempt({
          lookup: new KyselyEndpointTargetLookup(this.db),
          client: new SafeHttpClient({
            lookup: guard.lookup,
            hostCheck: (hostname) => guard.blockedHostReason(hostname),
          }),
          signatures: new SignatureService(),
          now: () => new Date(),
        }),
        this.attemptLog,
        () => new Date(),
      ),
      new BrokerRetryPublisher(new ConfirmPublisher(retryChannel), names),
      { policy, rng: Math.random, maxAttempts: MAX_ATTEMPTS },
    );

    // One channel per queue: the prefetch limit belongs to the channel, so each
    // lane gets its own and a busy lane cannot starve the others. The retries
    // come back through `retry.ready`, with a prefetch of their own.
    const consume = async (queue: string, prefetch: number) => {
      const channel = await this.broker.createChannel();
      this.channels.push(channel);
      this.consumers.push(
        await Consumer.start(
          channel,
          queue,
          async (message) => {
            this.logHandled(await handler.handle(message));
          },
          {
            prefetch,
            onHandlerError: (error, message) => this.report(error, message),
          },
        ),
      );
    };
    for (let lane = 0; lane < this.config.laneCount; lane++) {
      await consume(names.laneQueue(lane), this.config.prefetch);
    }
    await consume(names.retryReadyQueue, this.config.retryPrefetch);
    this.logger.log('worker started', {
      laneCount: this.config.laneCount,
      prefetch: this.config.prefetch,
      retryPrefetch: this.config.retryPrefetch,
      timeScale: this.config.timeScale,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.stop()));
    this.logger.log('worker stopped');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.close()));
  }

  private logHandled({ job, outcome, next }: RetryHandled): void {
    const context = {
      event_id: job.eventId,
      delivery_id: job.deliveryId,
      tenant_id: job.tenantId,
      attempt_no: job.attemptNo ?? 1,
    };
    if (outcome.kind === 'delivered') {
      this.logger.debug('delivery attempt succeeded', {
        ...context,
        status: outcome.status,
        latency_ms: outcome.latencyMs,
      });
      return;
    }
    if (outcome.kind === 'skipped') {
      this.logger.warn('delivery skipped', {
        ...context,
        ...describe(outcome),
      });
      return;
    }
    // Until the DLQ exists (Task 19), a delivery out of attempts ends here.
    this.logger.warn(
      next.kind === 'retry'
        ? 'delivery attempt failed, retry scheduled'
        : 'delivery attempt failed, no attempts left',
      {
        ...context,
        ...describe(outcome),
        ...(next.kind === 'retry'
          ? { next_attempt_no: next.attemptNo, retry_delay_ms: next.delayMs }
          : {}),
      },
    );
  }

  /**
   * Only a handler that threw reaches here. The consumer dead-letters the
   * message for it, except after a `RequeueError`, which keeps it queued.
   */
  private report(error: unknown, message: ConsumeMessage): void {
    const messageId = message.properties.messageId;
    if (error instanceof MalformedMessageError) {
      this.logger.warn('malformed delivery message dead-lettered', {
        message_id: messageId,
        reason: error.message,
      });
      return;
    }
    if (error instanceof RequeueError) {
      // The attempt was made but its retry could not be parked, so the job
      // goes back to its queue and is tried again: a duplicate, never a loss.
      this.logger.error('could not schedule the retry, job requeued', {
        message_id: messageId,
        error: errorText(error.cause ?? error),
      });
      return;
    }
    this.logger.error('unexpected error while delivering, dead-lettered', {
      message_id: messageId,
      error: errorText(error),
    });
  }
}

function describe(outcome: Exclude<AttemptOutcome, { kind: 'delivered' }>) {
  return outcome.kind === 'failed'
    ? {
        failure: outcome.failure,
        status: outcome.status,
        error: outcome.error,
        latency_ms: outcome.latencyMs,
      }
    : { reason: outcome.reason };
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
