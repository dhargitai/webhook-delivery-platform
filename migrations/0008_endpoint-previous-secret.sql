-- Up Migration

-- The secret an endpoint signed with before its last rotation, kept for the
-- overlap (PRD: 24 h) so receivers can deploy the new secret without dropping
-- deliveries: until `previous_secret_expires_at`, every request carries one
-- signature per secret. Sealed exactly like the current secret, with the same
-- AAD, so rotation moves its bytes here without opening them.
ALTER TABLE endpoints
  ADD COLUMN previous_secret_kek_id      text,
  ADD COLUMN previous_secret_wrapped_dek bytea,
  ADD COLUMN previous_secret_iv          bytea,
  ADD COLUMN previous_secret_ciphertext  bytea,
  ADD COLUMN previous_secret_tag         bytea,
  ADD COLUMN previous_secret_expires_at  timestamptz;

ALTER TABLE endpoints
  -- A previous secret is whole, with the end of its overlap, or absent: one
  -- without an expiry would sign forever.
  ADD CONSTRAINT endpoints_previous_secret_whole CHECK (
    num_nulls(previous_secret_kek_id, previous_secret_wrapped_dek,
              previous_secret_iv, previous_secret_ciphertext,
              previous_secret_tag, previous_secret_expires_at) IN (0, 6)
  ),
  -- The sizes the cipher writes, as for the current secret.
  ADD CONSTRAINT endpoints_previous_secret_shape CHECK (
    previous_secret_kek_id <> ''
    AND octet_length(previous_secret_iv) = 12
    AND octet_length(previous_secret_tag) = 16
    AND octet_length(previous_secret_wrapped_dek) = 60
  );

-- Down Migration

-- Lossless: the current secret stays, only the overlap ends early.
ALTER TABLE endpoints
  DROP CONSTRAINT endpoints_previous_secret_shape,
  DROP CONSTRAINT endpoints_previous_secret_whole,
  DROP COLUMN previous_secret_expires_at,
  DROP COLUMN previous_secret_tag,
  DROP COLUMN previous_secret_ciphertext,
  DROP COLUMN previous_secret_iv,
  DROP COLUMN previous_secret_wrapped_dek,
  DROP COLUMN previous_secret_kek_id;
