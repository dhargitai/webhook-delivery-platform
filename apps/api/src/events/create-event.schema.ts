import { z } from 'zod';

export const createEventSchema = z.strictObject({
  // The event type tenants subscribe endpoints to, e.g. "invoice.paid".
  type: z.string().min(1).max(255),
  // Forwarded as is, so any JSON value is allowed. The 64 KB body limit is
  // enforced earlier, by the body parser.
  payload: z.json(),
});

export type CreateEventBody = z.output<typeof createEventSchema>;

export const idempotencyKeySchema = z.string().min(1).max(255);
