import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequestValidationError } from './request-validation.error.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.strictObject({
  type: z.string().min(1),
  nested: z.object({ count: z.number() }),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value when it is valid', () => {
    const value = { type: 't', nested: { count: 1 } };

    expect(pipe.transform(value)).toEqual(value);
  });

  it('throws a RequestValidationError listing every issue with its path', () => {
    let error: unknown;
    try {
      pipe.transform({ type: '', nested: { count: 'x' } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RequestValidationError);
    const paths = (error as RequestValidationError).issues.map((i) => i.path);
    expect(paths.sort()).toEqual(['nested.count', 'type']);
  });

  it('reports a root-level failure with an empty path', () => {
    let error: unknown;
    try {
      pipe.transform('not an object');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RequestValidationError);
    expect((error as RequestValidationError).issues[0]?.path).toBe('');
  });
});
