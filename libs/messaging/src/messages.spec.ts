import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  deliveryRequestedSchema,
  encodeMessage,
  eventPublishedSchema,
  MalformedMessageError,
} from './messages.js';

const event = {
  eventId: '018f0000-0000-7000-8000-000000000001',
  tenantId: 'tenant-a',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42', lines: [1, 2, { a: null }] },
  createdAt: '2026-11-11T10:00:00.000Z',
};

const delivery = {
  deliveryId: 'a'.repeat(64),
  eventId: event.eventId,
  tenantId: 'tenant-a',
  endpointId: 'endpoint-1',
  eventType: 'invoice.paid',
  payload: { invoice: 'INV-42' },
};

describe('encodeMessage / decodeMessage', () => {
  it('round-trips an event message', () => {
    expect(decodeMessage(encodeMessage(event), eventPublishedSchema)).toEqual(
      event,
    );
  });

  it('round-trips a delivery message', () => {
    expect(
      decodeMessage(encodeMessage(delivery), deliveryRequestedSchema),
    ).toEqual(delivery);
  });

  it.each([
    { name: 'an array', payload: [1, 2] },
    { name: 'a string', payload: 'text' },
    { name: 'null', payload: null },
  ])('keeps $name payload as is', ({ payload }) => {
    const decoded = decodeMessage(
      encodeMessage({ ...event, payload }),
      eventPublishedSchema,
    );

    expect(decoded.payload).toEqual(payload);
  });

  it('rejects a body that is not JSON', () => {
    expect(() =>
      decodeMessage(Buffer.from('{not json'), eventPublishedSchema),
    ).toThrow(MalformedMessageError);
  });

  it.each(['eventId', 'tenantId', 'eventType', 'createdAt'] as const)(
    'rejects an event message without %s',
    (field) => {
      const { [field]: _removed, ...rest } = event;

      expect(() =>
        decodeMessage(encodeMessage(rest), eventPublishedSchema),
      ).toThrow(MalformedMessageError);
    },
  );

  it.each([
    'deliveryId',
    'eventId',
    'tenantId',
    'endpointId',
    'eventType',
  ] as const)('rejects a delivery message without %s', (field) => {
    const { [field]: _removed, ...rest } = delivery;

    expect(() =>
      decodeMessage(encodeMessage(rest), deliveryRequestedSchema),
    ).toThrow(MalformedMessageError);
  });

  it('rejects a field of the wrong type and names it', () => {
    let error: unknown;
    try {
      decodeMessage(
        encodeMessage({ ...event, eventId: 5 }),
        eventPublishedSchema,
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(MalformedMessageError);
    expect((error as Error).message).toContain('eventId');
  });

  it('rejects a createdAt that is not an ISO timestamp', () => {
    expect(() =>
      decodeMessage(
        encodeMessage({ ...event, createdAt: 'yesterday' }),
        eventPublishedSchema,
      ),
    ).toThrow(MalformedMessageError);
  });
});
