// Injection tokens for non-class values: the connections shared by the worker.
export const DATABASE = Symbol('DATABASE');
export const BROKER = Symbol('BROKER');
export const MONGO = Symbol('MONGO');
export const ATTEMPT_LOG = Symbol('ATTEMPT_LOG');
