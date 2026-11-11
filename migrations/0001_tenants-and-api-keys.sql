-- Up Migration

CREATE TABLE tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only the prefix (lookup handle) and a SHA-256 of the key are stored, never
-- the key itself.
CREATE TABLE api_keys (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  prefix     text        NOT NULL UNIQUE,
  key_hash   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX api_keys_tenant_id_idx ON api_keys (tenant_id);

-- Down Migration

DROP TABLE api_keys;
DROP TABLE tenants;
