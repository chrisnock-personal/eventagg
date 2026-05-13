-- ── Add timeout_ms to policies ────────────────────────────────────────────────
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS timeout_ms BIGINT NULL;

COMMENT ON COLUMN policies.timeout_ms IS
  'Auto-close groups after this many ms since last segment received. NULL = no timeout.';

-- ── Add status column to completed_events (default existing rows to completed) ─
ALTER TABLE completed_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

-- ── Add close_reason column ───────────────────────────────────────────────────
ALTER TABLE completed_events
  ADD COLUMN IF NOT EXISTS close_reason TEXT NULL;

-- ── Add check constraint ──────────────────────────────────────────────────────
ALTER TABLE completed_events
  DROP CONSTRAINT IF EXISTS completed_events_status_check;

ALTER TABLE completed_events
  ADD CONSTRAINT completed_events_status_check
    CHECK (status IN ('completed', 'timed_out'));

COMMENT ON COLUMN completed_events.status IS
  'completed = natural grave received, timed_out = auto-closed by timeout job.';

COMMENT ON COLUMN completed_events.close_reason IS
  'NULL = natural grave, ''policy_timeout'' = auto-closed by timeout job.';

-- ── Add last_segment_at to in_progress_events ─────────────────────────────────
ALTER TABLE in_progress_events
  ADD COLUMN IF NOT EXISTS last_segment_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN in_progress_events.last_segment_at IS
  'Timestamp of the most recently received segment. Timeout clock resets on each ingest.';

CREATE INDEX IF NOT EXISTS idx_in_progress_last_segment_at
  ON in_progress_events (last_segment_at);
