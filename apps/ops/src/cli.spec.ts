import { describe, expect, it } from 'vitest';
import { parseSeedArgs, readDatabaseUrl } from './cli.js';

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
