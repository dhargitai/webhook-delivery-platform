import { deliveryId } from '@wdp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { LaneRouter } from '../lane-router.js';
import { type DeliveryJob, DeliveryPublisher } from './delivery-publisher.js';
import { Dispatcher, PartialDispatchError } from './dispatcher.js';
import { SubscriptionLookup } from './subscription-lookup.js';

class FakeLookup extends SubscriptionLookup {
  /** endpoint ids per `${tenantId}/${eventType}`, in the order they are returned */
  readonly subscribers = new Map<string, string[]>();
  readonly queries: { tenantId: string; eventType: string }[] = [];

  subscribe(tenantId: string, eventType: string, ...endpointIds: string[]) {
    this.subscribers.set(`${tenantId}/${eventType}`, endpointIds);
  }

  async findActiveEndpointIds(
    tenantId: string,
    eventType: string,
  ): Promise<string[]> {
    this.queries.push({ tenantId, eventType });
    return this.subscribers.get(`${tenantId}/${eventType}`) ?? [];
  }
}

class FakePublisher extends DeliveryPublisher {
  readonly published: { job: DeliveryJob; routingKey: string }[] = [];
  readonly failing = new Set<string>();

  async publish(job: DeliveryJob, routingKey: string): Promise<void> {
    if (this.failing.has(job.endpointId)) {
      throw new Error(`broker refused ${job.endpointId}`);
    }
    this.published.push({ job, routingKey });
  }
}

describe('Dispatcher', () => {
  let lookup: FakeLookup;
  let publisher: FakePublisher;
  let router: LaneRouter;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    lookup = new FakeLookup();
    publisher = new FakePublisher();
    router = new LaneRouter(4);
    dispatcher = new Dispatcher(lookup, publisher, router);
  });

  const event = {
    eventId: 'evt-1',
    tenantId: 'tenant-a',
    eventType: 'invoice.paid',
    payload: { invoice: 'INV-42' },
  };

  it('publishes one delivery job per subscribed endpoint and returns how many', async () => {
    lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1', 'ep-2', 'ep-3');

    expect(await dispatcher.handle(event)).toBe(3);

    expect(publisher.published.map((p) => p.job.endpointId)).toEqual([
      'ep-1',
      'ep-2',
      'ep-3',
    ]);
  });

  it('copies the event onto each job and gives it a delivery id', async () => {
    lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1');

    await dispatcher.handle(event);

    expect(publisher.published[0]?.job).toEqual({
      deliveryId: deliveryId('evt-1', 'ep-1'),
      eventId: 'evt-1',
      tenantId: 'tenant-a',
      endpointId: 'ep-1',
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
    });
  });

  it('routes each job to the lane its endpoint belongs to', async () => {
    lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1', 'ep-2', 'ep-3');

    await dispatcher.handle(event);

    for (const { job, routingKey } of publisher.published) {
      expect(routingKey).toBe(router.routingKey(job.endpointId));
    }
  });

  it('asks only for the event tenant and type', async () => {
    await dispatcher.handle(event);

    expect(lookup.queries).toEqual([
      { tenantId: 'tenant-a', eventType: 'invoice.paid' },
    ]);
  });

  it('does nothing, without error, when nobody is subscribed', async () => {
    expect(await dispatcher.handle(event)).toBe(0);

    expect(publisher.published).toEqual([]);
  });

  it('gives the same delivery ids when the same event is handled again', async () => {
    lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1', 'ep-2');

    await dispatcher.handle(event);
    await dispatcher.handle(event);

    const ids = publisher.published.map((p) => p.job.deliveryId);
    expect(ids.slice(0, 2)).toEqual(ids.slice(2, 4));
    expect(new Set(ids).size).toBe(2);
  });

  it('gives different events different delivery ids for the same endpoint', async () => {
    lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1');

    await dispatcher.handle(event);
    await dispatcher.handle({ ...event, eventId: 'evt-2' });

    const [first, second] = publisher.published.map((p) => p.job.deliveryId);
    expect(first).not.toBe(second);
  });

  describe('when the broker refuses some jobs', () => {
    beforeEach(() => {
      lookup.subscribe('tenant-a', 'invoice.paid', 'ep-1', 'ep-2', 'ep-3');
      publisher.failing.add('ep-2');
    });

    it('still publishes the others, then reports the failure', async () => {
      await expect(dispatcher.handle(event)).rejects.toBeInstanceOf(
        PartialDispatchError,
      );

      expect(publisher.published.map((p) => p.job.endpointId)).toEqual([
        'ep-1',
        'ep-3',
      ]);
    });

    it('says how many went out and which endpoint failed', async () => {
      let error: unknown;
      try {
        await dispatcher.handle(event);
      } catch (e) {
        error = e;
      }

      const partial = error as PartialDispatchError;
      expect(partial.dispatched).toBe(2);
      expect(partial.failures).toEqual([
        { endpointId: 'ep-2', error: new Error('broker refused ep-2') },
      ]);
    });
  });

  it('fails when the subscription lookup fails, without publishing', async () => {
    lookup.findActiveEndpointIds = async () => {
      throw new Error('database down');
    };

    await expect(dispatcher.handle(event)).rejects.toThrow('database down');

    expect(publisher.published).toEqual([]);
  });
});
