import { describe, expect, it } from 'vitest';
import { Delivery, type DeliveryState } from './delivery.js';
import { DomainError } from './domain-error.js';
import { IllegalDeliveryTransitionError } from './illegal-delivery-transition-error.js';

type Action = 'start' | 'succeed' | 'fail';

/** Drives a fresh delivery into `state`, on its first attempt of three. */
function inState(state: DeliveryState): Delivery {
  const delivery = Delivery.pending({ maxAttempts: 3 });
  switch (state) {
    case 'pending':
      return delivery;
    case 'in-flight':
      delivery.start();
      return delivery;
    case 'succeeded':
      delivery.start();
      delivery.recordAttempt({ success: true });
      return delivery;
    case 'retrying':
      delivery.start();
      delivery.recordAttempt({ success: false });
      return delivery;
    case 'dead': {
      const last = Delivery.pending({ attemptNo: 3, maxAttempts: 3 });
      last.start();
      last.recordAttempt({ success: false });
      return last;
    }
  }
}

function act(delivery: Delivery, action: Action): unknown {
  switch (action) {
    case 'start':
      return delivery.start();
    case 'succeed':
      return delivery.recordAttempt({ success: true });
    case 'fail':
      return delivery.recordAttempt({ success: false });
  }
}

describe('Delivery', () => {
  it('starts pending on the first attempt unless told otherwise', () => {
    const delivery = Delivery.pending({ maxAttempts: 8 });

    expect(delivery.state).toBe('pending');
    expect(delivery.attemptNo).toBe(1);
  });

  it('carries the attempt number it is created with', () => {
    expect(Delivery.pending({ attemptNo: 4, maxAttempts: 8 }).attemptNo).toBe(
      4,
    );
  });

  describe('legal transitions', () => {
    it('start() puts a pending delivery in flight', () => {
      const delivery = inState('pending');

      delivery.start();

      expect(delivery.state).toBe('in-flight');
      expect(delivery.attemptNo).toBe(1);
    });

    it('a successful attempt succeeds the delivery', () => {
      const delivery = inState('in-flight');

      const event = delivery.recordAttempt({ success: true });

      expect(event).toEqual({ type: 'attempt-succeeded', attemptNo: 1 });
      expect(delivery.state).toBe('succeeded');
    });

    it('a failed attempt with attempts left schedules the next one', () => {
      const delivery = inState('in-flight');

      const event = delivery.recordAttempt({ success: false });

      expect(event).toEqual({
        type: 'attempt-failed',
        attemptNo: 1,
        nextAttemptNo: 2,
      });
      expect(delivery.state).toBe('retrying');
    });

    it('start() after a failure begins the next attempt', () => {
      const delivery = inState('retrying');

      delivery.start();

      expect(delivery.state).toBe('in-flight');
      expect(delivery.attemptNo).toBe(2);
    });

    it('a failed last attempt exhausts the delivery', () => {
      const delivery = inState('dead');

      expect(delivery.state).toBe('dead');
      expect(delivery.attemptNo).toBe(3);
    });

    it('reports the exhaustion as an event', () => {
      const delivery = Delivery.pending({ attemptNo: 3, maxAttempts: 3 });
      delivery.start();

      expect(delivery.recordAttempt({ success: false })).toEqual({
        type: 'delivery-exhausted',
        attemptNo: 3,
      });
    });

    it('walks the whole schedule: retries until the budget is spent, then dies', () => {
      const delivery = Delivery.pending({ maxAttempts: 8 });
      const events: unknown[] = [];

      for (let attempt = 1; attempt <= 8; attempt++) {
        delivery.start();
        expect(delivery.attemptNo).toBe(attempt);
        events.push(delivery.recordAttempt({ success: false }));
      }

      expect(events.slice(0, 7)).toEqual(
        Array.from({ length: 7 }, (_, i) => ({
          type: 'attempt-failed',
          attemptNo: i + 1,
          nextAttemptNo: i + 2,
        })),
      );
      expect(events[7]).toEqual({ type: 'delivery-exhausted', attemptNo: 8 });
      expect(delivery.state).toBe('dead');
    });

    it('a delivery with a single attempt dies on its first failure', () => {
      const delivery = Delivery.pending({ maxAttempts: 1 });
      delivery.start();

      expect(delivery.recordAttempt({ success: false })).toEqual({
        type: 'delivery-exhausted',
        attemptNo: 1,
      });
    });

    it('succeeds on a later attempt too', () => {
      const delivery = inState('retrying');
      delivery.start();

      const event = delivery.recordAttempt({ success: true });

      expect(event).toEqual({ type: 'attempt-succeeded', attemptNo: 2 });
      expect(delivery.state).toBe('succeeded');
    });
  });

  describe('illegal transitions', () => {
    const illegal: { state: DeliveryState; action: Action }[] = [
      { state: 'pending', action: 'succeed' },
      { state: 'pending', action: 'fail' },
      { state: 'in-flight', action: 'start' },
      { state: 'succeeded', action: 'start' },
      { state: 'succeeded', action: 'succeed' },
      { state: 'succeeded', action: 'fail' },
      { state: 'retrying', action: 'succeed' },
      { state: 'retrying', action: 'fail' },
      { state: 'dead', action: 'start' },
      { state: 'dead', action: 'succeed' },
      { state: 'dead', action: 'fail' },
    ];

    it.each(illegal)(
      '$action is rejected while $state',
      ({ state, action }) => {
        const delivery = inState(state);

        expect(() => act(delivery, action)).toThrow(
          IllegalDeliveryTransitionError,
        );
      },
    );

    it.each(illegal)(
      'a rejected $action leaves a $state delivery as it was',
      ({ state, action }) => {
        const delivery = inState(state);
        const attemptNo = delivery.attemptNo;

        expect(() => act(delivery, action)).toThrow();

        expect(delivery.state).toBe(state);
        expect(delivery.attemptNo).toBe(attemptNo);
      },
    );

    it('is a domain error that names the state and the action', () => {
      const error = new IllegalDeliveryTransitionError('dead', 'start');

      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe('ILLEGAL_DELIVERY_TRANSITION');
      expect(error.message).toContain('dead');
      expect(error.message).toContain('start');
    });
  });

  describe('invalid construction', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects a maxAttempts of %s',
      (maxAttempts) => {
        expect(() => Delivery.pending({ maxAttempts })).toThrow(RangeError);
      },
    );

    it.each([0, -1, 1.5, Number.NaN])('rejects an attemptNo of %s', (n) => {
      expect(() => Delivery.pending({ attemptNo: n, maxAttempts: 8 })).toThrow(
        RangeError,
      );
    });

    it('rejects an attemptNo beyond the budget', () => {
      expect(() => Delivery.pending({ attemptNo: 9, maxAttempts: 8 })).toThrow(
        RangeError,
      );
    });
  });
});
