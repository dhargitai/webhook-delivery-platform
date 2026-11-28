import { describe, expect, it } from 'vitest';
import {
  describeError,
  parseLoadTestArgs,
  parseSeedArgs,
  readDatabaseUrl,
  readKek,
  readLoadTestEnv,
} from './cli.js';

describe('readDatabaseUrl', () => {
  it('returns DATABASE_URL', () => {
    expect(readDatabaseUrl({ DATABASE_URL: 'postgres://u:p@h/db' })).toBe(
      'postgres://u:p@h/db',
    );
  });

  it.each([
    { name: 'missing', env: {} },
    { name: 'empty', env: { DATABASE_URL: '' } },
    { name: 'blank', env: { DATABASE_URL: '   ' } },
  ])('explains what to set when it is $name', ({ env }) => {
    expect(() => readDatabaseUrl(env)).toThrow(/DATABASE_URL/);
  });
});

describe('readKek', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

  it('decodes SECRETS_KEK_V1', () => {
    expect(readKek({ SECRETS_KEK_V1: key.toString('base64') })).toEqual(key);
  });

  it.each([
    { name: 'missing', env: {} },
    { name: 'empty', env: { SECRETS_KEK_V1: '' } },
  ])('explains what to set when it is $name', ({ env }) => {
    expect(() => readKek(env)).toThrow(/SECRETS_KEK_V1.*openssl rand/s);
  });

  it('refuses a malformed key without echoing it', () => {
    const value = Buffer.alloc(31, 9).toString('base64');

    expect(() => readKek({ SECRETS_KEK_V1: value })).toThrow(/SECRETS_KEK_V1/);
    expect(() => readKek({ SECRETS_KEK_V1: value })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(value),
      }),
    );
  });
});

describe('parseSeedArgs', () => {
  it('names the tenant "demo" by default', () => {
    expect(parseSeedArgs([])).toEqual({ tenantName: 'demo' });
  });

  it.each([
    { argv: ['--tenant', 'acme'], name: 'acme' },
    { argv: ['--tenant=acme'], name: 'acme' },
    { argv: ['--tenant', 'Acme Corp'], name: 'Acme Corp' },
  ])('reads $argv', ({ argv, name }) => {
    expect(parseSeedArgs(argv)).toEqual({ tenantName: name });
  });

  it.each([
    { name: 'a flag it does not know', argv: ['--nope'] },
    { name: 'a --tenant without a value', argv: ['--tenant'] },
    { name: 'an empty tenant name', argv: ['--tenant', ''] },
    { name: 'a stray positional argument', argv: ['acme'] },
  ])('rejects $name with a usage hint', ({ argv }) => {
    expect(() => parseSeedArgs(argv)).toThrow(/usage/i);
  });
});

describe('parseLoadTestArgs', () => {
  it('needs only a label, and defaults the rest to the isolation scenario', () => {
    expect(parseLoadTestArgs(['--label', 'one-worker'])).toEqual({
      label: 'one-worker',
      durationSeconds: 120,
      tenants: 6,
      ratePerTenant: 90,
      fanout: 1,
      noisyRate: 400,
      drainSeconds: 60,
    });
  });

  it('reads every flag, in either form', () => {
    expect(
      parseLoadTestArgs([
        '--label=two-workers',
        '--duration',
        '30',
        '--tenants=7',
        '--rate',
        '80',
        '--fanout=3',
        '--noisy-rate',
        '0',
        '--drain=90',
      ]),
    ).toEqual({
      label: 'two-workers',
      durationSeconds: 30,
      tenants: 7,
      ratePerTenant: 80,
      fanout: 3,
      noisyRate: 0,
      drainSeconds: 90,
    });
  });

  it.each([
    { name: 'no label', argv: ['--rate', '90'] },
    { name: 'a flag it does not know', argv: ['--label', 'a', '--nope', '1'] },
    { name: 'a flag without a value', argv: ['--label', 'a', '--rate'] },
    {
      name: 'a value that is not a number',
      argv: ['--label', 'a', '--rate', 'abc'],
    },
    { name: 'a fractional value', argv: ['--label', 'a', '--rate', '1.5'] },
    { name: 'a negative value', argv: ['--label', 'a', '--drain', '-1'] },
    { name: 'a stray positional argument', argv: ['--label', 'a', 'extra'] },
  ])('rejects $name with a usage hint', ({ argv }) => {
    expect(() => parseLoadTestArgs(argv)).toThrow(/usage/i);
  });
});

describe('readLoadTestEnv', () => {
  const env = {
    API_URL: 'http://api:3000',
    RECEIVER_URL: 'http://mock-receiver:4000',
    MONGO_URL: 'mongodb://mongo:27017',
  };

  it('defaults the Mongo database and the lane count', () => {
    expect(readLoadTestEnv(env)).toEqual({
      apiUrl: 'http://api:3000',
      receiverUrl: 'http://mock-receiver:4000',
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'wdp',
      laneCount: 4,
    });
  });

  it('treats an empty MONGO_DB or LANE_COUNT as unset', () => {
    // Compose and shells pass `VAR=` through as an empty string.
    expect(
      readLoadTestEnv({ ...env, MONGO_DB: '', LANE_COUNT: '' }),
    ).toMatchObject({ mongoDb: 'wdp', laneCount: 4 });
  });

  it('reads MONGO_DB and LANE_COUNT', () => {
    expect(
      readLoadTestEnv({ ...env, MONGO_DB: 'other', LANE_COUNT: '16' }),
    ).toMatchObject({ mongoDb: 'other', laneCount: 16 });
  });

  it.each([
    { variable: 'API_URL', patch: { API_URL: undefined } },
    { variable: 'RECEIVER_URL', patch: { RECEIVER_URL: '' } },
    { variable: 'MONGO_URL', patch: { MONGO_URL: undefined } },
    { variable: 'API_URL', patch: { API_URL: 'not a url' } },
    { variable: 'LANE_COUNT', patch: { LANE_COUNT: '0' } },
    { variable: 'LANE_COUNT', patch: { LANE_COUNT: 'four' } },
  ])('names $variable when it is missing or invalid', ({ variable, patch }) => {
    expect(() => readLoadTestEnv({ ...env, ...patch })).toThrow(variable);
  });
});

describe('describeError', () => {
  it('uses the message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('explains an empty AggregateError by its causes', () => {
    // What `pg` rejects with when neither ::1 nor 127.0.0.1 accepts a connection.
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), {
        code: 'ECONNREFUSED',
      });
    const error = new AggregateError(
      [refused('::1'), refused('127.0.0.1')],
      '',
    );

    expect(describeError(error)).toBe(
      'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('falls back to the code, then the name, of an error without a message', () => {
    expect(
      describeError(Object.assign(new Error(''), { code: 'ECONNRESET' })),
    ).toBe('ECONNRESET');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('describes a thrown non-error', () => {
    expect(describeError('plain')).toBe('plain');
  });
});
