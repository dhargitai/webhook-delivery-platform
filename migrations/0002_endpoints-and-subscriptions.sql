-- Up Migration

CREATE TABLE endpoints (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  url         text        NOT NULL,
  description text,
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite foreign key below.
  UNIQUE (id, tenant_id)
);

CREATE INDEX endpoints_tenant_id_idx ON endpoints (tenant_id);

CREATE TABLE subscriptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  endpoint_id uuid        NOT NULL,
  event_type  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_type),
  -- Ties the subscription to the endpoint's own tenant, so it can never point
  -- at another tenant's endpoint.
  FOREIGN KEY (endpoint_id, tenant_id)
    REFERENCES endpoints (id, tenant_id) ON DELETE CASCADE
);

-- The dispatcher looks subscriptions up by (tenant, event type).
CREATE INDEX subscriptions_tenant_event_type_idx
  ON subscriptions (tenant_id, event_type);

-- Down Migration

DROP TABLE subscriptions;
DROP TABLE endpoints;
