/**
 * Routing key of a fresh-delivery lane. One definition shared by the router
 * that picks a lane and the broker bindings that consume it, so the two can
 * never disagree on the format.
 */
export function laneRoutingKey(lane: number): string {
  return `fresh.shard.${String(lane).padStart(2, '0')}`;
}
