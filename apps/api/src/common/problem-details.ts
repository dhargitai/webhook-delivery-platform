import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import { IdempotencyConflictError, RateLimitExceededError } from '@wdp/domain';
import {
  RequestValidationError,
  type ValidationIssue,
} from './request-validation.error.js';

/** RFC 9457 problem details, served as application/problem+json. */
export interface ProblemDetails {
  type: 'about:blank';
  title: string;
  status: number;
  detail?: string;
  /** Stable machine-readable identifier of a domain failure. */
  code?: string;
  errors?: ValidationIssue[];
}

export interface Problem {
  status: number;
  headers: Record<string, string>;
  body: ProblemDetails;
}

function problem(
  status: number,
  extra: Partial<ProblemDetails> = {},
  headers: Record<string, string> = {},
): Problem {
  return {
    status,
    headers,
    body: {
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      ...extra,
    },
  };
}

/**
 * Client errors raised by libraries rather than by us, notably body-parser's
 * 413 and 400, which carry a numeric `status` in the 4xx range.
 */
function clientErrorStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) {
    return null;
  }
  const status = (exception as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : null;
}

/**
 * The single place where failures get an HTTP status. Pure, so every mapping
 * is unit tested without an HTTP server.
 */
export function toProblem(exception: unknown): Problem {
  if (exception instanceof RequestValidationError) {
    return problem(422, {
      title: 'Validation failed',
      errors: exception.issues,
    });
  }
  if (exception instanceof IdempotencyConflictError) {
    return problem(422, {
      title: 'Idempotency key reused',
      detail: exception.message,
      code: exception.code,
    });
  }
  if (exception instanceof RateLimitExceededError) {
    return problem(
      429,
      { detail: exception.message, code: exception.code },
      { 'Retry-After': String(exception.retryAfterSeconds) },
    );
  }
  if (exception instanceof HttpException) {
    return problem(exception.getStatus(), { detail: exception.message });
  }
  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== null) {
    return problem(clientStatus, {
      detail: exception instanceof Error ? exception.message : undefined,
    });
  }
  // Anything else is a bug or an infrastructure failure. Its message may hold
  // internals (hosts, credentials), so none of it reaches the client.
  return problem(500);
}
