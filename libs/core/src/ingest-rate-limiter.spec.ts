import { describe, expect, it } from 'vitest';
import { DEFAULT_INGEST_RATE_LIMIT } from './ingest-rate-limiter.js';

describe('DEFAULT_INGEST_RATE_LIMIT', () => {
  // Locked by the PRD: changing either number is a deliberate decision.
  it('is 100 events/s sustained with a burst of 200', () => {
    expect(DEFAULT_INGEST_RATE_LIMIT).toEqual({
      ratePerSecond: 100,
      burst: 200,
    });
  });
});
