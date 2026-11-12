// Injection tokens for the connections every service shares. They are
// non-class values (an SDK instance each), so a class token cannot be used.
export const DATABASE = Symbol('DATABASE');
export const BROKER = Symbol('BROKER');
export const MONGO = Symbol('MONGO');
export const REDIS = Symbol('REDIS');
