import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { toProblem } from './problem-details.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const problem = toProblem(exception);

    // Only server faults are logged here: the client already gets a 4xx body
    // describing what it did wrong.
    if (problem.status >= 500) {
      this.logger.error(
        'unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(problem.status)
      .set(problem.headers)
      // Set before json(), which only fills in a content type when none exists.
      .type('application/problem+json')
      .json(problem.body);
  }
}
