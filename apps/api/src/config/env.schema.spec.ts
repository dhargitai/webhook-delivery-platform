import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  REDIS_URL: 'redis://localhost',
};

describe('api env schema', () => {
  it('applies the PRD defaults', () => {
    expect(envSchema.parse(required)).toEqual({
      ...required,
      PORT: 3000,
      INGEST_RATE_PER_SECOND: 100,
      INGEST_BURST: 200,
      SSRF_ALLOW_HOSTS: [],
    });
  });

  it.each(['DATABASE_URL', 'REDIS_URL'] as const)('requires %s', (name) => {
    const { [name]: _removed, ...rest } = required;

    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    { name: 'a port of 0', env: { PORT: '0' } },
    { name: 'a port above 65535', env: { PORT: '70000' } },
    { name: 'a non-positive rate', env: { INGEST_RATE_PER_SECOND: '0' } },
    { name: 'a fractional burst', env: { INGEST_BURST: '1.5' } },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });

  describe('SSRF_ALLOW_HOSTS', () => {
    it.each([
      { raw: '', hosts: [] },
      { raw: 'mock-receiver', hosts: ['mock-receiver'] },
      { raw: 'mock-receiver,localhost', hosts: ['mock-receiver', 'localhost'] },
      {
        raw: ' Mock-Receiver , LOCALHOST ,',
        hosts: ['mock-receiver', 'localhost'],
      },
      { raw: ',,  ,', hosts: [] },
    ])('reads $raw as $hosts', ({ raw, hosts }) => {
      expect(
        envSchema.parse({ ...required, SSRF_ALLOW_HOSTS: raw })
          .SSRF_ALLOW_HOSTS,
      ).toEqual(hosts);
    });
  });
});
