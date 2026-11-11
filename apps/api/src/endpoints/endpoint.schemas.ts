import { validateEndpointUrl } from '@wdp/core';
import { z } from 'zod';

/** The endpoint URL rules, with the hosts that may skip the https and port rules. */
function urlSchema(allowHosts: readonly string[]) {
  return z
    .string()
    .max(2048)
    .transform((value, ctx) => {
      const result = validateEndpointUrl(value, { allowHosts });
      if (!result.ok) {
        ctx.issues.push({
          code: 'custom',
          message: result.reason,
          input: value,
        });
        return z.NEVER;
      }
      return result.url;
    });
}

/** `allowHosts` comes from `SSRF_ALLOW_HOSTS`: development only, empty in production. */
export function createEndpointSchema(allowHosts: readonly string[] = []) {
  return z.strictObject({
    url: urlSchema(allowHosts),
    description: z
      .string()
      .max(500)
      .nullish()
      .transform((value) => value ?? null),
  });
}

export type CreateEndpointBody = z.output<
  ReturnType<typeof createEndpointSchema>
>;

export const replaceSubscriptionsSchema = z.strictObject({
  event_types: z.array(z.string().min(1).max(255)).max(50),
});

export type ReplaceSubscriptionsBody = z.output<
  typeof replaceSubscriptionsSchema
>;
