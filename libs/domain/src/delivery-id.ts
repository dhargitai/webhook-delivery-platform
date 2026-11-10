import { createHash } from 'node:crypto';

/**
 * Deterministic id of the delivery of one event to one endpoint. The
 * dispatcher is idempotent on it: redispatching an event yields the same ids.
 *
 * The pair is JSON-encoded before hashing so ("ab", "c") and ("a", "bc")
 * cannot collide.
 */
export function deliveryId(eventId: string, endpointId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([eventId, endpointId]))
    .digest('hex');
}
