import { z } from 'zod';

/** How the receiver should treat one webhook, chosen by the URL's query string. */
export interface Behaviour {
  /** Chance, 0 to 1, that the request fails. */
  failRate: number;
  /** Status of a failed request. */
  failStatus: number;
  /** Status of a request that does not fail. */
  status: number;
  /** Delay before answering. */
  latencyMs: number;
  /** Never answer, so the caller has to give up on its own timeout. */
  hang: boolean;
}

export interface BehaviourIssue {
  param: string;
  message: string;
}

export class InvalidBehaviourError extends Error {
  constructor(readonly issues: BehaviourIssue[]) {
    super(`invalid parameters: ${issues.map((i) => i.param).join(', ')}`);
    this.name = new.target.name;
  }
}

const flag = z
  .enum(['1', 'true', '0', 'false'])
  .transform((value) => value === '1' || value === 'true');

const schema = z.object({
  fail: z.coerce.number().min(0).max(1).default(0),
  failStatus: z.coerce.number().int().min(400).max(599).default(500),
  status: z.coerce.number().int().min(100).max(599).default(200),
  // Up to a minute: enough to outlast the worker's 10 s total timeout.
  latency: z.coerce.number().int().min(0).max(60_000).default(0),
  hang: flag.default(false),
});

const KNOWN = ['fail', 'failStatus', 'status', 'latency', 'hang'] as const;

/** Reads the behaviour from a query string. Unknown parameters are ignored. */
export function parseBehaviour(params: URLSearchParams): Behaviour {
  // Only the parameters this receiver owns reach the schema, and a missing
  // one is simply absent, which is what makes its default apply.
  const raw: Record<string, string> = {};
  for (const name of KNOWN) {
    const value = params.get(name);
    if (value !== null) {
      raw[name] = value;
    }
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InvalidBehaviourError(
      result.error.issues.map((issue) => ({
        param: String(issue.path[0] ?? ''),
        message: issue.message,
      })),
    );
  }
  const { fail, failStatus, status, latency, hang } = result.data;
  return { failRate: fail, failStatus, status, latencyMs: latency, hang };
}
