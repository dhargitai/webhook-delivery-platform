import type { AttemptOutcome, DeliveryJob } from '@wdp/core';
import { decodeMessage, deliveryRequestedSchema } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';

export interface HandledJob {
  job: DeliveryJob;
  outcome: AttemptOutcome;
}

/**
 * Turns a message from a lane queue into a delivery attempt. It resolves for
 * every outcome, a failed or skipped attempt included, and the consumer acks
 * only after it has: the ack waits for the attempt. Anything it throws, a
 * malformed message included, makes the consumer reject the message without
 * requeueing, which dead-letters it.
 */
export class JobMessageHandler {
  constructor(
    private readonly delivery: {
      attempt(job: DeliveryJob): Promise<AttemptOutcome>;
    },
  ) {}

  async handle(message: ConsumeMessage): Promise<HandledJob> {
    const job = decodeMessage(message.content, deliveryRequestedSchema);
    const outcome = await this.delivery.attempt(job);
    return { job, outcome };
  }
}
