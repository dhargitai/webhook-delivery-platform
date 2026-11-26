import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyProvider, type WrappedKey } from './key-provider.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
/** iv ‖ ciphertext ‖ tag: GCM's ciphertext is as long as the DEK. */
const WRAPPED_DEK_BYTES = IV_BYTES + DEK_BYTES + TAG_BYTES;

export interface EnvKeyProviderOptions {
  /** Stored with every wrapped DEK, so a later KEK can be told apart from this one. */
  kekId: string;
  /** The 32-byte KEK, decoded from the environment (`SECRETS_KEK_V1`). */
  key: Buffer;
}

/**
 * A single KEK held in process memory, read from the environment. Wraps each
 * DEK with AES-256-GCM under a fresh IV, stored as one value:
 * `iv(12) ‖ ciphertext(32) ‖ tag(16)`.
 */
export class EnvKeyProvider extends KeyProvider {
  private readonly kekId: string;
  private readonly key: Buffer;

  constructor({ kekId, key }: EnvKeyProviderOptions) {
    super();
    if (kekId === '') {
      throw new RangeError('kekId must not be empty');
    }
    if (key.length !== KEY_BYTES) {
      throw new RangeError(
        `the KEK must be ${KEY_BYTES} bytes, got ${key.length}`,
      );
    }
    this.kekId = kekId;
    // A copy, so the caller zeroing or reusing its buffer cannot change it.
    this.key = Buffer.from(key);
  }

  wrap(dek: Buffer): Promise<WrappedKey> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Promise.resolve({
      kekId: this.kekId,
      wrappedDek: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]),
    });
  }

  async unwrap({ kekId, wrappedDek }: WrappedKey): Promise<Buffer> {
    if (kekId !== this.kekId) {
      throw new Error(`no KEK with id ${kekId}`);
    }
    if (wrappedDek.length !== WRAPPED_DEK_BYTES) {
      throw new Error(
        `a wrapped DEK is ${WRAPPED_DEK_BYTES} bytes, got ${wrappedDek.length}`,
      );
    }
    const iv = wrappedDek.subarray(0, IV_BYTES);
    const ciphertext = wrappedDek.subarray(IV_BYTES, IV_BYTES + DEK_BYTES);
    const tag = wrappedDek.subarray(IV_BYTES + DEK_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    // `final` throws when the tag does not match: a tampered wrapped DEK or
    // another KEK never yields a key.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
