import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  EndpointNotFoundError,
  IdempotencyConflictError,
  RateLimitExceededError,
  SecretRotationInProgressError,
  UrlNotAllowedError,
} from '@wdp/domain';
import { describe, expect, it } from 'vitest';
import { toProblem } from './problem-details.js';
import { RequestValidationError } from './request-validation.error.js';

/** Shaped like the errors body-parser raises for bad or oversized bodies. */
const bodyParserError = (status: number, type: string) =>
  Object.assign(new Error(`body-parser: ${type}`), { status, type });

describe('toProblem', () => {
  it('maps a validation failure to 422 and lists each issue', () => {
    const problem = toProblem(
      new RequestValidationError([
        { path: 'type', message: 'Required' },
        { path: 'payload.a', message: 'Expected string' },
      ]),
    );

    expect(problem.status).toBe(422);
    expect(problem.body).toMatchObject({
      status: 422,
      title: 'Validation failed',
      errors: [
        { path: 'type', message: 'Required' },
        { path: 'payload.a', message: 'Expected string' },
      ],
    });
  });

  it('maps an idempotency conflict to 422 with its code', () => {
    const problem = toProblem(new IdempotencyConflictError('key reused'));

    expect(problem.status).toBe(422);
    expect(problem.body).toMatchObject({
      status: 422,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      detail: 'key reused',
    });
  });

  it('maps a refused endpoint URL to 422, naming the reason on the url field', () => {
    const problem = toProblem(
      new UrlNotAllowedError('169.254.169.254 is link-local'),
    );

    expect(problem.status).toBe(422);
    expect(problem.body).toEqual({
      type: 'about:blank',
      title: 'URL not allowed',
      status: 422,
      code: 'URL_NOT_ALLOWED',
      detail: '169.254.169.254 is link-local',
      errors: [{ path: 'url', message: '169.254.169.254 is link-local' }],
    });
  });

  it('maps a missing resource to 404 with its code', () => {
    const problem = toProblem(new EndpointNotFoundError('ep-1'));

    expect(problem.status).toBe(404);
    expect(problem.body).toMatchObject({
      status: 404,
      code: 'ENDPOINT_NOT_FOUND',
    });
  });

  it('maps a rotation still in its overlap to 409, saying when it ends', () => {
    const problem = toProblem(
      new SecretRotationInProgressError(new Date('2026-11-29T12:00:00.000Z')),
    );

    expect(problem.status).toBe(409);
    expect(problem.body).toEqual({
      type: 'about:blank',
      title: 'Secret rotation in progress',
      status: 409,
      code: 'SECRET_ROTATION_IN_PROGRESS',
      detail:
        'the previous signing secret is in use until 2026-11-29T12:00:00.000Z',
    });
  });

  it('maps a rate limit to 429 with a Retry-After header', () => {
    const problem = toProblem(new RateLimitExceededError(7));

    expect(problem.status).toBe(429);
    expect(problem.headers).toEqual({ 'Retry-After': '7' });
    expect(problem.body).toMatchObject({
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it.each([
    { name: 'unauthorized', error: new UnauthorizedException(), status: 401 },
    { name: 'not found', error: new NotFoundException(), status: 404 },
    {
      name: 'a payload that is too large',
      error: bodyParserError(413, 'entity.too.large'),
      status: 413,
    },
    {
      name: 'malformed JSON',
      error: bodyParserError(400, 'entity.parse.failed'),
      status: 400,
    },
  ])('keeps the status of $name', ({ error, status }) => {
    const problem = toProblem(error);

    expect(problem.status).toBe(status);
    expect(problem.body.status).toBe(status);
  });

  it('turns an unexpected error into a generic 500 without leaking its message', () => {
    const problem = toProblem(
      new Error('connect ECONNREFUSED db password=hunter2'),
    );

    expect(problem.status).toBe(500);
    expect(problem.body.title).toBe('Internal Server Error');
    expect(JSON.stringify(problem.body)).not.toContain('hunter2');
  });

  it('does not pass through the status of a non-client error from a library', () => {
    const problem = toProblem(bodyParserError(503, 'something.internal'));

    expect(problem.status).toBe(500);
  });

  it('handles a thrown non-Error value', () => {
    expect(toProblem('boom').status).toBe(500);
  });
});
