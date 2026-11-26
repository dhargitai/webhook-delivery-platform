-- Up Migration

-- An endpoint's signing secret encrypted at rest, AES-256-GCM envelope
-- encryption (PRD): its own data key (DEK) encrypts it, and a key-encryption
-- key (KEK) the database never sees wraps the DEK. The application seals and
-- opens it; the AAD binds it to its tenant and endpoint.
--
-- Expand step: the plaintext column stays, nullable, until the ops backfill
-- (`seal-secrets`) has sealed every row that predates this migration. A
-- later migration drops it.
ALTER TABLE endpoints
  ADD COLUMN secret_kek_id      text,
  ADD COLUMN secret_wrapped_dek bytea,
  ADD COLUMN secret_iv          bytea,
  ADD COLUMN secret_ciphertext  bytea,
  ADD COLUMN secret_tag         bytea,
  ALTER COLUMN signing_secret DROP NOT NULL;

ALTER TABLE endpoints
  -- A sealed secret is whole or absent, never half written.
  ADD CONSTRAINT endpoints_secret_sealed_whole CHECK (
    num_nulls(secret_kek_id, secret_wrapped_dek, secret_iv,
              secret_ciphertext, secret_tag) IN (0, 5)
  ),
  -- Exactly one form: no endpoint without a secret, and never the plaintext
  -- left next to its sealed copy.
  ADD CONSTRAINT endpoints_secret_one_form CHECK (
    (signing_secret IS NULL) <> (secret_ciphertext IS NULL)
  ),
  -- The sizes the cipher writes: a 12-byte IV, a 16-byte tag (a shorter one
  -- is easier to forge), and a wrapped DEK of iv(12) + key(32) + tag(16).
  ADD CONSTRAINT endpoints_secret_sealed_shape CHECK (
    secret_kek_id <> ''
    AND octet_length(secret_iv) = 12
    AND octet_length(secret_tag) = 16
    AND octet_length(secret_wrapped_dek) = 60
  );

-- Down Migration

-- Fails while any endpoint holds only a sealed secret, on purpose: SQL cannot
-- open it, and dropping the columns would lose it.
ALTER TABLE endpoints
  DROP CONSTRAINT endpoints_secret_sealed_shape,
  DROP CONSTRAINT endpoints_secret_one_form,
  DROP CONSTRAINT endpoints_secret_sealed_whole,
  ALTER COLUMN signing_secret SET NOT NULL,
  DROP COLUMN secret_tag,
  DROP COLUMN secret_ciphertext,
  DROP COLUMN secret_iv,
  DROP COLUMN secret_wrapped_dek,
  DROP COLUMN secret_kek_id;
