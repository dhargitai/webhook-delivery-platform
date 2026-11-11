import { validateEndpointUrl } from '@wdp/core';
import { z } from 'zod';

const urlSchema = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    const result = validateEndpointUrl(value);
    if (!result.ok) {
      ctx.issues.push({ code: 'custom', message: result.reason, input: value });
      return z.NEVER;
    }
    return result.url;
  });

export const createEndpointSchema = z.strictObject({
  url: urlSchema,
  description: z
    .string()
    .max(500)
    .nullish()
    .transform((value) => value ?? null),
});

export type CreateEndpointBody = z.output<typeof createEndpointSchema>;

export const replaceSubscriptionsSchema = z.strictObject({
  event_types: z.array(z.string().min(1).max(255)).max(50),
});

export type ReplaceSubscriptionsBody = z.output<
  typeof replaceSubscriptionsSchema
>;
