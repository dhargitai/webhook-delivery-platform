import { describe, expect, it } from 'vitest';
import { UuidV7EventIdGenerator } from './uuid-event-id-generator.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7EventIdGenerator', () => {
  it('generates version 7 UUIDs', () => {
    expect(new UuidV7EventIdGenerator().next()).toMatch(UUID_V7);
  });

  it('never repeats an id', () => {
    const ids = new UuidV7EventIdGenerator();
    const generated = Array.from({ length: 1000 }, () => ids.next());

    expect(new Set(generated).size).toBe(1000);
  });

  it('generates ids that sort in generation order', () => {
    const ids = new UuidV7EventIdGenerator();
    const generated = Array.from({ length: 1000 }, () => ids.next());

    expect([...generated].sort()).toEqual(generated);
  });
});
