-- Up Migration

-- Keeps the retention purge cheap: it deletes the oldest published events in
-- batches, so it reads this index from the start and stops at the cutoff
-- instead of scanning the whole table. Unpublished rows are never purged and
-- are left out.
CREATE INDEX events_published_created_idx
  ON events (created_at)
  WHERE published_at IS NOT NULL;

-- Down Migration

DROP INDEX events_published_created_idx;
