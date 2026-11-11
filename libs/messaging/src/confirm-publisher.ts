import type { Message, Options } from 'amqplib';

/** The part of an amqplib ConfirmChannel the publisher needs. */
export interface PublishChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: (err: unknown) => void,
  ): boolean;
  on(event: 'return', listener: (message: Message) => void): unknown;
}

export interface PublishProperties {
  /** Stable id of the message; consumers deduplicate on it. */
  messageId: string;
  /** Ties the message to the event it belongs to, across services. */
  correlationId?: string;
  /** Message type name, for consumers that route on it. */
  type?: string;
  /** Custom headers, such as an attempt counter that survives dead-lettering. */
  headers?: Record<string, unknown>;
}

export interface ConfirmPublisherOptions {
  /** How long to wait for the broker's confirm. PRD: 5 s. */
  confirmTimeoutMs?: number;
}

/** The broker did not accept the message: a nack, or the channel failed. */
export class PublishFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No confirm arrived in time, so the message may or may not be stored. */
export class ConfirmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no broker confirm within ${timeoutMs} ms`);
    this.name = new.target.name;
  }
}

/** The broker confirmed the message but no queue was bound to receive it. */
export class UnroutableMessageError extends Error {
  constructor(exchange: string, routingKey: string) {
    super(`no queue bound to ${exchange} for routing key "${routingKey}"`);
    this.name = new.target.name;
  }
}

/**
 * Publishes persistent messages and resolves only once the broker has them,
 * so a caller can safely record "published" afterwards.
 *
 * Messages are `mandatory`: without that, publishing to an exchange with no
 * matching queue is confirmed and then silently dropped, and the caller would
 * mark an event published that nobody will ever receive.
 */
export class ConfirmPublisher {
  private readonly confirmTimeoutMs: number;
  /** Ids of messages the broker returned as unroutable, until their confirm arrives. */
  private readonly returned = new Set<string>();

  constructor(
    private readonly channel: PublishChannel,
    { confirmTimeoutMs = 5_000 }: ConfirmPublisherOptions = {},
  ) {
    this.confirmTimeoutMs = confirmTimeoutMs;
    // AMQP sends basic.return before the basic.ack of the same message.
    channel.on('return', (message) => {
      const { messageId } = message.properties;
      if (typeof messageId === 'string') {
        this.returned.add(messageId);
      }
    });
  }

  publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    { messageId, correlationId, type, headers }: PublishProperties,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ConfirmTimeoutError(this.confirmTimeoutMs)),
        this.confirmTimeoutMs,
      );

      try {
        this.channel.publish(
          exchange,
          routingKey,
          body,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId,
            correlationId,
            type,
            headers,
          },
          (error) => {
            clearTimeout(timer);
            const wasReturned = this.returned.delete(messageId);
            if (error) {
              reject(
                new PublishFailedError('broker did not confirm the message', {
                  cause: error,
                }),
              );
            } else if (wasReturned) {
              reject(new UnroutableMessageError(exchange, routingKey));
            } else {
              resolve();
            }
          },
        );
      } catch (error) {
        // A closed channel throws synchronously.
        clearTimeout(timer);
        reject(
          new PublishFailedError('could not publish on the channel', {
            cause: error,
          }),
        );
      }
    });
  }
}
