import type { DispatchableEvent } from '@wdp/core';
import { encodeMessage, MalformedMessageError } from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventMessageHandler } from './event-message-handler.js';

class FakeDispatcher {
  readonly events: DispatchableEvent[] = [];
  failWith: Error | undefined;

  async handle(event: DispatchableEvent): Promise<number> {
    if (this.failWith) throw this.failWith;
    this.events.push(event);
    return 0;
  }
}

const message = (body: Buffer) => ({ content: body }) as ConsumeMessage;

const valid = {
  eventId: '018f0000-0000-7000-8000-000000000001',
  tenantId: 'tenant-a',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42' },
  createdAt: '2026-11-11T10:00:00.000Z',
};

describe('EventMessageHandler', () => {
  let dispatcher: FakeDispatcher;
  let handler: EventMessageHandler;

  beforeEach(() => {
    dispatcher = new FakeDispatcher();
    handler = new EventMessageHandler(dispatcher);
  });

  it('hands the decoded event to the dispatcher', async () => {
    await handler.handle(message(encodeMessage(valid)));

    expect(dispatcher.events).toEqual([
      {
        eventId: valid.eventId,
        tenantId: 'tenant-a',
        eventType: 'invoice.paid',
        payload: { invoice: 'INV-42' },
      },
    ]);
  });

  it('rejects a body that is not JSON, without calling the dispatcher', async () => {
    await expect(
      handler.handle(message(Buffer.from('{broken'))),
    ).rejects.toBeInstanceOf(MalformedMessageError);

    expect(dispatcher.events).toEqual([]);
  });

  it('rejects a message that breaks the event contract', async () => {
    const { eventId: _removed, ...withoutId } = valid;

    await expect(
      handler.handle(message(encodeMessage(withoutId))),
    ).rejects.toBeInstanceOf(MalformedMessageError);

    expect(dispatcher.events).toEqual([]);
  });

  it('lets a dispatcher failure through, so the message is dead-lettered', async () => {
    dispatcher.failWith = new Error('broker refused a job');

    await expect(handler.handle(message(encodeMessage(valid)))).rejects.toThrow(
      'broker refused a job',
    );
  });
});
