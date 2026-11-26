/** A data key as stored: wrapped by the key-encryption key named by `kekId`. */
export interface WrappedKey {
  kekId: string;
  wrappedDek: Buffer;
}

/**
 * Holds the key-encryption keys (KEKs) that protect each secret's own data
 * key (DEK). Shaped like a KMS on purpose, wrap and unwrap only and both
 * async: a KMS never hands out the KEK, and each call is a network round trip,
 * so a KMS adapter can replace the environment key without touching callers.
 */
export abstract class KeyProvider {
  /** Wraps a DEK under the current KEK. */
  abstract wrap(dek: Buffer): Promise<WrappedKey>;

  /** The DEK back; rejects for an unknown KEK or a wrapped DEK that fails authentication. */
  abstract unwrap(wrapped: WrappedKey): Promise<Buffer>;
}
