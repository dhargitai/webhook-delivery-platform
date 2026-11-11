import type { DispatchableEvent } from '@wdp/core';
import { decodeMessage, eventPublishedSchema } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';

/**
 * Turns a message from the dispatch queue into a dispatch. Anything this
 * throws, a malformed message included, makes the consumer reject the message
 * without requeueing, which dead-letters it: retrying cannot fix a bad body.
 */
export class EventMessageHandler {
  constructor(
    private readonly dispatcher: {
      handle(event: DispatchableEvent): Promise<number>;
    },
  ) {}

  /** Returns how many delivery jobs the event produced. */
  async handle(message: ConsumeMessage): Promise<number> {
    const { eventId, tenantId, eventType, payload } = decodeMessage(
      message.content,
      eventPublishedSchema,
    );
    return this.dispatcher.handle({ eventId, tenantId, eventType, payload });
  }
}
