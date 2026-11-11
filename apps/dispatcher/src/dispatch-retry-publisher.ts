import type { ConsumeMessage } from 'amqplib';

/**
 * Where a failed dispatch goes next. Both calls resolve only once the broker
 * has the copy, so the caller can ack the original afterwards.
 */
export abstract class DispatchRetryPublisher {
  /** Parks the event until the retry delay has passed, as attempt number `attempt`. */
  abstract retry(message: ConsumeMessage, attempt: number): Promise<void>;
  /** Gives up on the event: dead-letters it with the reason. */
  abstract deadLetter(message: ConsumeMessage, reason: string): Promise<void>;
}
