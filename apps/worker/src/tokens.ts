// Injection token for a non-class value owned by the worker. The connections
// it shares with the other services come from `@wdp/common`.
export const ATTEMPT_LOG = Symbol('ATTEMPT_LOG');
