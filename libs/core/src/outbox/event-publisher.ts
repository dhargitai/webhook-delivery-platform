import type { OutboxEvent } from './outbox-store.js';

/** Hands one event to the broker. Resolves only once the broker has it. */
export abstract class EventPublisher {
  abstract publish(event: OutboxEvent): Promise<void>;
}
