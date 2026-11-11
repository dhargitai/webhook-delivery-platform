import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { RequestValidationError } from './request-validation.error.js';

/** Validates a body, header or param against a Zod schema and returns the parsed value. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
