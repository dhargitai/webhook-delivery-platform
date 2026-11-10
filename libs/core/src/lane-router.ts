import { createHash } from 'node:crypto';

/**
 * Maps an endpoint to one of the fresh-delivery lanes, so all traffic for an
 * endpoint shares a lane and a slow endpoint only slows its own shard.
 *
 * Changing the lane count remaps endpoints, so it needs a queue drain.
 */
export class LaneRouter {
  constructor(private readonly laneCount: number) {
    if (!Number.isInteger(laneCount) || laneCount < 1) {
      throw new RangeError(
        `laneCount must be a positive integer, got ${laneCount}`,
      );
    }
  }

  routingKey(endpointId: string): string {
    // First 32 bits of a SHA-256 are uniformly distributed, unlike a string
    // hash that clusters on similar ids.
    const bucket = createHash('sha256')
      .update(endpointId)
      .digest()
      .readUInt32BE(0);
    const lane = bucket % this.laneCount;
    return `fresh.shard.${String(lane).padStart(2, '0')}`;
  }
}
