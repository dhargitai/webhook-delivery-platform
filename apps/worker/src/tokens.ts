// Injection tokens for non-class values owned by the worker. The connections
// it shares with the other services come from `@wdp/common`.
export const ATTEMPT_LOG = Symbol('ATTEMPT_LOG');
// A token rather than the class, so tests can swap in a breaker with shorter
// timings than the PRD's.
export const CIRCUIT_BREAKER = Symbol('CIRCUIT_BREAKER');
