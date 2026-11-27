import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

const ALGORITHM = 'aes-256-gcm';
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * An endpoint signing secret as stored at rest (PRD: `{kek_id, wrapped_dek,
 * iv, ciphertext, tag}`). Nothing in it reveals the secret without the KEK.
 */
export interface SealedSecret {
  kekId: string;
  wrappedDek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/** What the worker needs from the cipher: open only, never seal. */
export interface SecretOpener {
  open(sealed: SealedSecret, aad: string): Promise<string>;
}

/**
 * The associated data that binds a sealed secret to its endpoint row. A
 * ciphertext copied onto another endpoint, or another tenant's, then fails
 * authentication instead of signing that endpoint's webhooks. The version is
 * part of the format: changing it orphans every stored secret.
 */
export function secretAad(tenantId: string, endpointId: string): string {
  return `wdp:endpoint-secret:v1:${tenantId}:${endpointId}`;
}

/**
 * Envelope encryption of endpoint signing secrets with AES-256-GCM: each
 * secret gets its own random data key (DEK), which encrypts it and is then
 * wrapped by the key provider's KEK. Rotating or replacing the KEK only
 * re-wraps DEKs; a leaked DEK exposes one secret.
 */
export class SecretCipher implements SecretOpener {
  constructor(private readonly keys: KeyProvider) {}

  async seal(plaintext: string, aad: string): Promise<SealedSecret> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, dek, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const { kekId, wrappedDek } = await this.keys.wrap(dek);
      return { kekId, wrappedDek, iv, ciphertext, tag: cipher.getAuthTag() };
    } finally {
      // The DEK exists in the clear only for this call.
      dek.fill(0);
    }
  }

  async open(sealed: SealedSecret, aad: string): Promise<string> {
    const dek = await this.keys.unwrap({
      kekId: sealed.kekId,
      wrappedDek: sealed.wrappedDek,
    });
    try {
      // A fixed tag length: without it Node 24 still accepts GCM tags as short
      // as 4 bytes (deprecated, DEP0182), far easier to forge than the 16
      // this cipher always writes. Newer Node refuses them on its own.
      const decipher = createDecipheriv(ALGORITHM, dek, sealed.iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(sealed.tag);
      // `final` throws when the tag does not match: tampering, another
      // endpoint's AAD or another DEK never yields a secret.
      return Buffer.concat([
        decipher.update(sealed.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }
}
