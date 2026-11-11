import type { Channel, ConsumeMessage } from 'amqplib';

export type MessageHandler = (message: ConsumeMessage) => Promise<void>;

export interface ConsumerOptions {
  /** Most unacknowledged messages in flight, so also the most handlers at once. */
  prefetch: number;
  /**
   * Called when a handler throws, or when an ack or nack could not be sent.
   * Must not throw.
   */
  onHandlerError: (error: unknown, message: ConsumeMessage) => void;
}

/**
 * Consumes a queue with manual acks, in this order: run the handler, then ack.
 * A handler that throws gets its message rejected without requeue, which sends
 * it to the dead-letter exchange immediately. A requeue would redeliver it in
 * a tight loop. A consumer that dies mid-handler never acks, so the broker
 * redelivers the message (at-least-once).
 */
export class Consumer {
  private constructor(
    private readonly channel: Channel,
    private readonly consumerTag: string,
    private readonly inFlight: Set<Promise<void>>,
  ) {}

  static async start(
    channel: Channel,
    queue: string,
    handler: MessageHandler,
    { prefetch, onHandlerError }: ConsumerOptions,
  ): Promise<Consumer> {
    if (!Number.isInteger(prefetch) || prefetch < 1) {
      throw new RangeError(
        `prefetch must be a positive integer, got ${prefetch}`,
      );
    }
    const inFlight = new Set<Promise<void>>();

    const handle = async (message: ConsumeMessage): Promise<void> => {
      let failure: { error: unknown } | undefined;
      try {
        await handler(message);
      } catch (error) {
        failure = { error };
      }

      try {
        if (failure) {
          channel.nack(message, false, false);
        } else {
          channel.ack(message);
        }
      } catch (error) {
        // The channel closed under us. The broker redelivers the message.
        onHandlerError(error, message);
      }
      if (failure) {
        onHandlerError(failure.error, message);
      }
    };

    await channel.prefetch(prefetch);
    const { consumerTag } = await channel.consume(
      queue,
      (message) => {
        if (message === null) {
          return; // the broker cancelled this consumer
        }
        const task: Promise<void> = handle(message).finally(() =>
          inFlight.delete(task),
        );
        inFlight.add(task);
      },
      { noAck: false },
    );
    return new Consumer(channel, consumerTag, inFlight);
  }

  /**
   * Graceful stop: no new deliveries, and resolves once every handler already
   * running has finished and acked. The channel stays open for the caller to close.
   */
  async stop(): Promise<void> {
    await this.channel.cancel(this.consumerTag);
    await Promise.allSettled(this.inFlight);
  }
}
