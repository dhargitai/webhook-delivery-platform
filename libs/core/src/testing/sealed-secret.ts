import { randomBytes, randomUUID } from 'node:crypto';
import { generateEndpointSecret } from '../endpoint-secret.js';
import { EnvKeyProvider } from '../secrets/env-key-provider.js';
import { SecretCipher, secretAad } from '../secrets/secret-cipher.js';

/** A fresh random KEK, base64 as `SECRETS_KEK_V1` holds it. */
export function testKek(): string {
  return randomBytes(32).toString('base64');
}

/** The cipher an app builds from that `SECRETS_KEK_V1`, for seeding and assertions. */
export function testCipher(kekBase64: string): SecretCipher {
  return new SecretCipher(
    new EnvKeyProvider({ kekId: 'v1', key: Buffer.from(kekBase64, 'base64') }),
  );
}

/**
 * The `endpoints` columns of `secret` sealed for one endpoint, for specs that
 * insert endpoint rows directly. The id must be the row's own: the seal is
 * bound to it, so the row needs an id chosen before the insert.
 */
export async function sealedSecretColumns(
  cipher: SecretCipher,
  tenantId: string,
  endpointId: string,
  secret: string,
) {
  const sealed = await cipher.seal(secret, secretAad(tenantId, endpointId));
  return {
    secret_kek_id: sealed.kekId,
    secret_wrapped_dek: sealed.wrappedDek,
    secret_iv: sealed.iv,
    secret_ciphertext: sealed.ciphertext,
    secret_tag: sealed.tag,
  };
}

/**
 * The `endpoints` columns of a previous (pre-rotation) secret sealed for one
 * endpoint, signing until `expiresAt`. Bound to the endpoint like the current
 * secret, so the same id rule applies.
 */
export async function sealedPreviousSecretColumns(
  cipher: SecretCipher,
  tenantId: string,
  endpointId: string,
  secret: string,
  expiresAt: Date,
) {
  const sealed = await cipher.seal(secret, secretAad(tenantId, endpointId));
  return {
    previous_secret_kek_id: sealed.kekId,
    previous_secret_wrapped_dek: sealed.wrappedDek,
    previous_secret_iv: sealed.iv,
    previous_secret_ciphertext: sealed.ciphertext,
    previous_secret_tag: sealed.tag,
    previous_secret_expires_at: expiresAt,
  };
}

/**
 * The id and sealed-secret columns of a new endpoint row, for specs that
 * insert endpoints directly: spread into `.values({...})`.
 */
export async function sealedEndpointRow(
  cipher: SecretCipher,
  tenantId: string,
  secret: string = generateEndpointSecret(),
) {
  const id = randomUUID();
  return {
    id,
    ...(await sealedSecretColumns(cipher, tenantId, id, secret)),
  };
}
