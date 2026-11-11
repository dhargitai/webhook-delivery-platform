import {
  type AttemptLog,
  type AttemptOutcome,
  type DeliveryJob,
  toAttemptRecord,
} from '@wdp/core';
import { decodeMessage, deliveryRequestedSchema } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';

export interface HandledJob {
  job: DeliveryJob;
  outcome: AttemptOutcome;
}

/**
 * Turns a message from a lane queue into a delivery attempt and logs it. It
 * resolves for every outcome, a failed or skipped attempt included, and the
 * consumer acks only after it has: the ack waits for the attempt and for its
 * log record, so an acked job is always in the log. Anything it throws, a
 * malformed message or a log that cannot be written included, makes the
 * consumer reject the message without requeueing, which dead-letters it.
 */
export class JobMessageHandler {
  constructor(
    private readonly delivery: {
      attempt(job: DeliveryJob): Promise<AttemptOutcome>;
    },
    private readonly log: AttemptLog,
    private readonly now: () => Date,
  ) {}

  async handle(message: ConsumeMessage): Promise<HandledJob> {
    const job = decodeMessage(message.content, deliveryRequestedSchema);
    // The log says when the attempt was made, not when it finished.
    const startedAt = this.now();
    const outcome = await this.delivery.attempt(job);
    // A skipped attempt made no call, so it has no record.
    const record = toAttemptRecord(job, outcome, startedAt);
    if (record) await this.log.record(record);
    return { job, outcome };
  }
}
