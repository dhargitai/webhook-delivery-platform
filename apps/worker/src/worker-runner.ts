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
  type AttemptOutcome,
  type Database,
  DeliveryAttempt,
  KyselyEndpointTargetLookup,
  SafeHttpClient,
  SignatureService,
  SsrfGuard,
} from '@wdp/core';
import {
  type BrokerConnection,
  Consumer,
  declareTopology,
  MalformedMessageError,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { Kysely } from 'kysely';
import { workerConfig } from './config/worker.config.js';
import { type HandledJob, JobMessageHandler } from './job-message-handler.js';
import { BROKER, DATABASE } from './tokens.js';

/**
 * Owns the worker's lifecycle. Nest runs shutdown hooks in a fixed order,
 * which is what makes the stop graceful: the consumers stop first
 * (onModuleDestroy), finishing the jobs they already hold, and only then are
 * the connections closed (onApplicationShutdown).
 */
@Injectable()
export class WorkerRunner
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly consumers: Consumer[] = [];
  private readonly channels: { close(): Promise<void> }[] = [];

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(BROKER) private readonly broker: BrokerConnection,
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Declared here so the worker works against a fresh broker.
    const setup = await this.broker.createChannel();
    const names = await declareTopology(setup, {
      laneCount: this.config.laneCount,
      namespace: this.config.brokerNamespace,
    });
    await setup.close();

    // One guard supplies both checks: the connect-time lookup for names and
    // the host check for IP literals, which never reach the lookup.
    const guard = new SsrfGuard({ allowHosts: this.config.ssrfAllowHosts });
    const handler = new JobMessageHandler(
      new DeliveryAttempt({
        lookup: new KyselyEndpointTargetLookup(this.db),
        client: new SafeHttpClient({
          lookup: guard.lookup,
          hostCheck: (hostname) => guard.blockedHostReason(hostname),
        }),
        signatures: new SignatureService(),
        now: () => new Date(),
      }),
    );

    // One channel per lane: the prefetch limit belongs to the channel, so each
    // lane gets its own and a busy lane cannot starve the others.
    for (let lane = 0; lane < this.config.laneCount; lane++) {
      const channel = await this.broker.createChannel();
      this.channels.push(channel);
      this.consumers.push(
        await Consumer.start(
          channel,
          names.laneQueue(lane),
          async (message) => {
            this.logHandled(await handler.handle(message));
          },
          {
            prefetch: this.config.prefetch,
            onHandlerError: (error, message) => this.report(error, message),
          },
        ),
      );
    }
    this.logger.log('worker started', {
      laneCount: this.config.laneCount,
      prefetch: this.config.prefetch,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.stop()));
    this.logger.log('worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.close()));
    await this.broker.close();
    await this.db.destroy();
  }

  private logHandled({ job, outcome }: HandledJob): void {
    const context = {
      event_id: job.eventId,
      delivery_id: job.deliveryId,
      tenant_id: job.tenantId,
    };
    if (outcome.kind === 'delivered') {
      this.logger.debug('delivery attempt succeeded', {
        ...context,
        status: outcome.status,
        latency_ms: outcome.latencyMs,
      });
      return;
    }
    // Until retries exist (Task 18), a failed or skipped attempt ends here.
    this.logger.warn(
      outcome.kind === 'failed'
        ? 'delivery attempt failed, not retried yet'
        : 'delivery skipped',
      { ...context, ...describe(outcome) },
    );
  }

  /**
   * Only a handler that threw reaches here, and the consumer rejected the
   * message for it, which dead-letters it.
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
