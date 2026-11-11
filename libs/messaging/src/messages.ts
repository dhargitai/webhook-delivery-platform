import { z } from 'zod';

/** An accepted event, published by the outbox relay for the dispatcher. */
export const eventPublishedSchema = z.object({
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.json(),
  createdAt: z.iso.datetime(),
});
export type EventPublished = z.output<typeof eventPublishedSchema>;

/** One event bound for one endpoint, published by the dispatcher for a worker. */
export const deliveryRequestedSchema = z.object({
  deliveryId: z.string().min(1),
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  endpointId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.json(),
});
export type DeliveryRequested = z.output<typeof deliveryRequestedSchema>;

/** The body of a message did not match its contract. Retrying cannot fix it. */
export class MalformedMessageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function encodeMessage(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

/** Parses and validates a message body; consumers never trust the wire. */
export function decodeMessage<T extends z.ZodType>(
  body: Buffer,
  schema: T,
): z.output<T> {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (cause) {
    throw new MalformedMessageError('message body is not valid JSON', {
      cause,
    });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new MalformedMessageError(`invalid message: ${problems}`);
  }
  return result.data;
}
