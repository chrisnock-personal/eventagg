-- ── Fix duration_ms overflow ──────────────────────────────────────────────────
-- INT (32-bit) overflows at ~24.8 days. Change to BIGINT for long-running groups.
-- For partitioned tables, drop the column on the PARENT only — partitions inherit.

ALTER TABLE completed_events DROP COLUMN IF EXISTS duration_ms;

ALTER TABLE completed_events
  ADD COLUMN duration_ms BIGINT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (ended_at - started_at))::BIGINT * 1000
  ) STORED;

-- Recreate the index on the new column
DROP INDEX IF EXISTS idx_ce_duration;
CREATE INDEX IF NOT EXISTS idx_ce_duration ON completed_events (duration_ms);
