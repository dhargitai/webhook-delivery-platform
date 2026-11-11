import { describe, expect, it } from 'vitest';
import { InvalidBehaviourError, parseBehaviour } from './behaviour.js';

const parse = (query: string) => parseBehaviour(new URLSearchParams(query));

describe('parseBehaviour', () => {
  it('answers 200 at once and never fails by default', () => {
    expect(parse('')).toEqual({
      failRate: 0,
      failStatus: 500,
      status: 200,
      latencyMs: 0,
      hang: false,
    });
  });

  it.each([
    { query: 'fail=0.3', expected: { failRate: 0.3 } },
    { query: 'fail=0', expected: { failRate: 0 } },
    { query: 'fail=1', expected: { failRate: 1 } },
    { query: 'failStatus=503', expected: { failStatus: 503 } },
    { query: 'status=429', expected: { status: 429 } },
    { query: 'status=204', expected: { status: 204 } },
    { query: 'latency=250', expected: { latencyMs: 250 } },
    { query: 'latency=60000', expected: { latencyMs: 60000 } },
    { query: 'hang=1', expected: { hang: true } },
    { query: 'hang=true', expected: { hang: true } },
    { query: 'hang=0', expected: { hang: false } },
    { query: 'hang=false', expected: { hang: false } },
  ])('reads $query', ({ query, expected }) => {
    expect(parse(query)).toMatchObject(expected);
  });

  it('combines several parameters', () => {
    expect(parse('fail=0.5&latency=100&failStatus=502&status=202')).toEqual({
      failRate: 0.5,
      failStatus: 502,
      status: 202,
      latencyMs: 100,
      hang: false,
    });
  });

  it('ignores parameters it does not know, as real webhook URLs carry their own', () => {
    expect(parse('token=abc&fail=1')).toMatchObject({ failRate: 1 });
  });

  it.each([
    { query: 'fail=2', param: 'fail' },
    { query: 'fail=-0.1', param: 'fail' },
    { query: 'fail=often', param: 'fail' },
    { query: 'failStatus=200', param: 'failStatus' },
    { query: 'failStatus=700', param: 'failStatus' },
    { query: 'status=99', param: 'status' },
    { query: 'status=600', param: 'status' },
    { query: 'status=ok', param: 'status' },
    { query: 'latency=-1', param: 'latency' },
    { query: 'latency=60001', param: 'latency' },
    { query: 'latency=1.5', param: 'latency' },
    { query: 'hang=maybe', param: 'hang' },
  ])('rejects $query and names $param', ({ query, param }) => {
    let error: unknown;
    try {
      parse(query);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InvalidBehaviourError);
    expect(
      (error as InvalidBehaviourError).issues.map((i) => i.param),
    ).toContain(param);
  });

  it('reports every invalid parameter, not just the first', () => {
    let error: unknown;
    try {
      parse('fail=9&latency=-5');
    } catch (e) {
      error = e;
    }

    expect(
      (error as InvalidBehaviourError).issues.map((i) => i.param).sort(),
    ).toEqual(['fail', 'latency']);
  });
});
