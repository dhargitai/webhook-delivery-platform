// Injection token for a non-class value: the Redis client shared across
// modules. The database token comes from `@wdp/common`.
export const REDIS = Symbol('REDIS');
