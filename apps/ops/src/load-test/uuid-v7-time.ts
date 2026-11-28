// Version nibble 7 and the RFC 9562 variant (10xx: 8, 9, a or b).
const UUID_V7 =
  /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The Unix time in ms a UUIDv7 was made at: its first 48 bits. The API makes
 * every `event_id` at ingest, so this is the event's acceptance time, and
 * delivery jobs need not carry one for the load test.
 */
export function uuidV7Millis(id: string): number {
  const match = UUID_V7.exec(id);
  if (match === null) {
    throw new Error(`not a UUIDv7: "${id}"`);
  }
  // 48 bits fit a double exactly (integers are exact up to 2^53).
  return Number.parseInt(`${match[1]}${match[2]}`, 16);
}
