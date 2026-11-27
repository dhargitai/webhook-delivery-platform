import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { type SecretCipher, secretAad } from './secret-cipher.js';

export interface SealPlaintextSecretsOptions {
  /** Rows sealed per transaction. */
  batchSize?: number;
}

/**
 * The backfill of the expand step: seals every endpoint secret still stored
 * in plaintext, in place, and clears the plaintext. The secret itself does
 * not change, so receivers keep verifying. Idempotent, and safe to run from
 * two places at once: `SKIP LOCKED` hands each row to one of them.
 *
 * @returns how many secrets were sealed
 */
export async function sealPlaintextSecrets(
  db: Kysely<Database>,
  cipher: SecretCipher,
  { batchSize = 100 }: SealPlaintextSecretsOptions = {},
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      `batchSize must be a positive integer, got ${batchSize}`,
    );
  }

  let total = 0;
  for (;;) {
    // One short transaction per batch, so a large backlog never holds locks
    // on every endpoint at once.
    const sealed = await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('endpoints')
        .select(['id', 'tenant_id', 'signing_secret'])
        .where('signing_secret', 'is not', null)
        .orderBy('id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        // The filter above guarantees it; narrowed for the type checker.
        if (row.signing_secret === null) continue;
        const secret = await cipher.seal(
          row.signing_secret,
          secretAad(row.tenant_id, row.id),
        );
        await trx
          .updateTable('endpoints')
          .set({
            signing_secret: null,
            secret_kek_id: secret.kekId,
            secret_wrapped_dek: secret.wrappedDek,
            secret_iv: secret.iv,
            secret_ciphertext: secret.ciphertext,
            secret_tag: secret.tag,
          })
          .where('id', '=', row.id)
          .execute();
      }
      return rows.length;
    });
    total += sealed;
    if (sealed === 0) return total;
  }
}
