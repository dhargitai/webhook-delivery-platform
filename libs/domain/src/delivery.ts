import { IllegalDeliveryTransitionError } from './illegal-delivery-transition-error.js';

export type DeliveryState =
  'pending' | 'in-flight' | 'succeeded' | 'retrying' | 'dead';

/** What recording an attempt led to. */
export type DeliveryEvent =
  | { type: 'attempt-succeeded'; attemptNo: number }
  | { type: 'attempt-failed'; attemptNo: number; nextAttemptNo: number }
  | { type: 'delivery-exhausted'; attemptNo: number };

export interface DeliveryOptions {
  /** The attempt the delivery is on, from 1. A replay or a retry job starts later. */
  attemptNo?: number;
  /** The attempt budget (PRD: 8). The domain does not know the retry schedule. */
  maxAttempts: number;
}

/**
 * The lifecycle of one delivery across its attempts, as an explicit state
 * machine:
 *
 *     pending ─start→ in-flight ─success→ succeeded
 *                        │ ↑
 *                        │ └──start── retrying ←─┐
 *                        └─failure, attempts left┘
 *                        └─failure, budget spent→ dead
 *
 * The aggregate decides whether a failed attempt is retried or final, from the
 * budget alone. How long a retry waits is the retry policy's business. Pure: no
 * clock, no I/O. An illegal transition throws and leaves the state untouched.
 */
export class Delivery {
  private current: DeliveryState = 'pending';
  private attempt: number;

  private constructor(
    attemptNo: number,
    private readonly maxAttempts: number,
  ) {
    this.attempt = attemptNo;
  }

  static pending({ attemptNo = 1, maxAttempts }: DeliveryOptions): Delivery {
    assertPositiveInteger('maxAttempts', maxAttempts);
    assertPositiveInteger('attemptNo', attemptNo);
    if (attemptNo > maxAttempts) {
      throw new RangeError(
        `attemptNo ${attemptNo} is beyond the budget of ${maxAttempts} attempts`,
      );
    }
    return new Delivery(attemptNo, maxAttempts);
  }

  get state(): DeliveryState {
    return this.current;
  }

  /** The attempt in progress, or the one the next `start()` begins. */
  get attemptNo(): number {
    return this.attempt;
  }

  /** Begins an attempt: the first one, or the one after a failure. */
  start(): void {
    if (this.current === 'retrying') {
      this.attempt += 1;
    } else if (this.current !== 'pending') {
      throw new IllegalDeliveryTransitionError(this.current, 'start');
    }
    this.current = 'in-flight';
  }

  recordAttempt({ success }: { success: boolean }): DeliveryEvent {
    if (this.current !== 'in-flight') {
      throw new IllegalDeliveryTransitionError(
        this.current,
        'record an attempt',
      );
    }
    if (success) {
      this.current = 'succeeded';
      return { type: 'attempt-succeeded', attemptNo: this.attempt };
    }
    if (this.attempt < this.maxAttempts) {
      this.current = 'retrying';
      return {
        type: 'attempt-failed',
        attemptNo: this.attempt,
        nextAttemptNo: this.attempt + 1,
      };
    }
    this.current = 'dead';
    return { type: 'delivery-exhausted', attemptNo: this.attempt };
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
