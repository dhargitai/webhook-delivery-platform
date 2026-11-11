import { inspect } from 'node:util';
import {
  DISPATCH_ATTEMPT_HEADER,
  MalformedMessageError,
  RequeueError,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import type { DispatchRetryPublisher } from './dispatch-retry-publisher.js';

export interface DispatchFailureObserver {
  /** The event was parked and will be dispatched again as attempt `nextAttempt`. */
  onRetryScheduled(
    message: ConsumeMessage,
    nextAttempt: number,
    error: unknown,
  ): void;
  /** The attempts ran out: the event was dead-lettered. */
  onExhausted(message: ConsumeMessage, attempts: number, error: unknown): void;
}

export interface DispatchFailureOptions extends DispatchFailureObserver {
  /** Dispatch tries per event, the first one included. */
  maxAttempts: number;
}

/**
 * Decides what a failed dispatch leads to, instead of letting the consumer
 * dead-letter the whole event on the first error.
 *
 * - A malformed message is rethrown: no retry can fix it, so it is
 *   dead-lettered at once.
 * - Anything else is treated as transient. The event is parked in the retry
 *   queue and dispatched again as a whole. Job ids are deterministic, so jobs
 *   that already went out come out again under the same ids.
 * - Past `maxAttempts` it is dead-lettered with the reason, so a persistent
 *   failure ends visibly instead of looping.
 *
 * The copy is confirmed by the broker before this returns, so the consumer's
 * ack comes after it: a crash in between duplicates the event, never loses it.
 * If even the copy cannot be published, `RequeueError` keeps the original.
 */
export class DispatchFailureHandler {
  constructor(
    private readonly inner: {
      handle(message: ConsumeMessage): Promise<number>;
    },
    private readonly retries: DispatchRetryPublisher,
    private readonly options: DispatchFailureOptions,
  ) {}

  /** Returns how many jobs the event produced, or `undefined` if it was parked or given up on. */
  async handle(message: ConsumeMessage): Promise<number | undefined> {
    try {
      return await this.inner.handle(message);
    } catch (error) {
      if (error instanceof MalformedMessageError) {
        throw error;
      }
      await this.park(message, error);
      return undefined;
    }
  }

  private async park(message: ConsumeMessage, error: unknown): Promise<void> {
    const attempt = attemptOf(message);
    const exhausted = attempt >= this.options.maxAttempts;
    try {
      if (exhausted) {
        await this.retries.deadLetter(message, reasonOf(error));
      } else {
        await this.retries.retry(message, attempt + 1);
      }
    } catch (publishError) {
      throw new RequeueError('could not park the failed event', {
        cause: publishError,
      });
    }
    // Outside the try: a failing observer must not requeue an event that is
    // already safely parked.
    if (exhausted) {
      this.options.onExhausted(message, attempt, error);
    } else {
      this.options.onRetryScheduled(message, attempt + 1, error);
    }
  }
}

/** The attempt a message is on. A missing or nonsensical header means the first. */
function attemptOf(message: ConsumeMessage): number {
  const value: unknown = message.properties.headers?.[DISPATCH_ATTEMPT_HEADER];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : 1;
}

/** Something thrown, as text: anything can be thrown, not only errors. */
function describe(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return typeof thrown === 'string' ? thrown : inspect(thrown);
}

/** The error's message followed by its causes', since a wrapper alone says little. */
function reasonOf(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current !== undefined;) {
    parts.push(describe(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}
