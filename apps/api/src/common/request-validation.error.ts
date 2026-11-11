export interface ValidationIssue {
  /** Dotted path to the offending field; empty when the whole value is wrong. */
  path: string;
  message: string;
}

/** A request failed schema validation. Mapped to 422 by the problem-details filter. */
export class RequestValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super('request validation failed');
    this.name = new.target.name;
  }
}
