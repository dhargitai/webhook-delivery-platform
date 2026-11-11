import type { DeliveryJob, RetryPolicy } from '@wdp/core';
import { Delivery } from '@wdp/domain';
import { RequeueError } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import type { HandledJob } from './job-message-handler.js';
import type { RetryPublisher } from './retry-publisher.js';

/** What the handler did about the attempt, for the caller to log. */
export type NextStep =
  /** Nothing to do: delivered, or no call was made. */
  | { kind: 'none' }
  /** The job was parked and will be tried again as attempt `attemptNo`. */
  | { kind: 'retry'; attemptNo: number; delayMs: number }
  /** The attempt budget is spent. */
  | { kind: 'exhausted' };

export interface RetryHandled extends HandledJob {
  next: NextStep;
}

export interface RetryHandlerOptions {
  /** Picks the retry tier. The delivery decides whether there is a retry at all. */
  policy: Pick<RetryPolicy, 'next'>;
  /** In [0, 1): picks the jitter bucket. */
  rng: () => number;
  /** Attempts per delivery, the first included (PRD: 8). */
  maxAttempts: number;
}

/**
 * Decides what a failed attempt leads to, instead of letting it end the job.
 *
 * It runs after the attempt and its log record, in this order: publish the
 * retry, wait for the broker's confirm, resolve. The consumer acks only after
 * it resolves, so a crash in between redelivers the job and the receiver sees
 * the same `webhook-id` again: a duplicate, never a loss.
 *
 * - The `Delivery` state machine decides retry or give up, from the budget.
 *   The policy only says how long a retry waits.
 * - A failure on the last attempt resolves without a retry (the job is acked;
 *   Task 19 gives it a DLQ entry).
 * - A retry that cannot be published throws `RequeueError`, which keeps the
 *   original job queued.
 * - Anything the inner handler throws, a malformed message or a log that
 *   cannot be written included, passes through and dead-letters the job.
 */
export class RetryHandler {
  constructor(
    private readonly inner: {
      handle(message: ConsumeMessage): Promise<HandledJob>;
    },
    private readonly retries: RetryPublisher,
    private readonly options: RetryHandlerOptions,
  ) {}

  async handle(message: ConsumeMessage): Promise<RetryHandled> {
    const handled = await this.inner.handle(message);
    const { job, outcome } = handled;
    // No call was made, so there is no attempt to count or to retry.
    if (outcome.kind === 'skipped')
      return { ...handled, next: { kind: 'none' } };

    const delivery = Delivery.pending({
      attemptNo: job.attemptNo ?? 1,
      maxAttempts: this.options.maxAttempts,
    });
    delivery.start();
    const event = delivery.recordAttempt({
      success: outcome.kind === 'delivered',
    });

    switch (event.type) {
      case 'attempt-succeeded':
        return { ...handled, next: { kind: 'none' } };
      case 'delivery-exhausted':
        return { ...handled, next: { kind: 'exhausted' } };
      case 'attempt-failed':
        return {
          ...handled,
          next: await this.schedule(job, event.attemptNo, event.nextAttemptNo),
        };
    }
  }

  private async schedule(
    job: DeliveryJob,
    failedAttemptNo: number,
    nextAttemptNo: number,
  ): Promise<NextStep> {
    const decision = this.options.policy.next(
      failedAttemptNo,
      this.options.rng,
    );
    if (decision.action === 'dead') {
      // The budget allows a retry that the schedule has no tier for. Guessing
      // a delay would hide a misconfiguration.
      throw new Error(
        `attempt ${failedAttemptNo} has attempts left but the retry schedule has no tier for it`,
      );
    }
    try {
      await this.retries.retry(
        { ...job, attemptNo: nextAttemptNo },
        decision.delay,
      );
    } catch (error) {
      throw new RequeueError('could not schedule the retry', { cause: error });
    }
    return { kind: 'retry', attemptNo: nextAttemptNo, delayMs: decision.delay };
  }
}
