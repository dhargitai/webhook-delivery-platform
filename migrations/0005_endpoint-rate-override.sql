-- Up Migration

-- An endpoint's own delivery rate, over the platform's default (20 calls/s,
-- burst 40). NULL keeps the default, each column on its own.
--
-- The checks hold the values the limiter accepts, so a stored override can
-- never fail a delivery: `< 'Infinity'` also rejects NaN, which Postgres sorts
-- above every other number, and which `> 0` alone would let through.
ALTER TABLE endpoints
  ADD COLUMN rate_per_second double precision
    CHECK (rate_per_second > 0 AND rate_per_second < 'Infinity'),
  ADD COLUMN burst integer
    CHECK (burst >= 1);

-- Down Migration

ALTER TABLE endpoints
  DROP COLUMN burst,
  DROP COLUMN rate_per_second;
