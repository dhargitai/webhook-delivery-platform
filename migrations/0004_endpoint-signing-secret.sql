-- Up Migration

-- gen_random_bytes() for the backfill below. A trusted extension, so the
-- database owner may create it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The secret a receiver verifies webhook signatures with, `whsec_<base64 of 32
-- random bytes>`. Plaintext for now; it is encrypted at rest in a later change.
-- The application generates it, so there is no default.
ALTER TABLE endpoints ADD COLUMN signing_secret text;

-- Endpoints that already exist get a secret of their own.
UPDATE endpoints
   SET signing_secret = 'whsec_' || encode(gen_random_bytes(32), 'base64');

ALTER TABLE endpoints ALTER COLUMN signing_secret SET NOT NULL;

-- Down Migration

ALTER TABLE endpoints DROP COLUMN signing_secret;
