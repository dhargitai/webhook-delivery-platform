import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RequestValidationError } from '../common/request-validation.error.js';
import { idempotencyKeySchema } from './create-event.schema.js';

/**
 * The validated `Idempotency-Key` header, or null when the client sent none.
 * `@Headers()` cannot take pipes, hence the dedicated decorator.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const raw = context.switchToHttp().getRequest<Request>().headers[
      'idempotency-key'
    ];
    if (raw === undefined) {
      return null;
    }
    const result = idempotencyKeySchema.safeParse(raw);
    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: 'Idempotency-Key',
          message: issue.message,
        })),
      );
    }
    return result.data;
  },
);
