-- ── 009: Auto-partition pre-creation, duplicate guard, covering indexes ────────

-- 1. Pre-create partitions through 2028 Q2 (background job keeps this rolling)
CREATE TABLE IF NOT EXISTS completed_events_2027_q2
    PARTITION OF completed_events
    FOR VALUES FROM ('2027-04-01') TO ('2027-07-01');

CREATE TABLE IF NOT EXISTS completed_events_2027_q3
    PARTITION OF completed_events
    FOR VALUES FROM ('2027-07-01') TO ('2027-10-01');

CREATE TABLE IF NOT EXISTS completed_events_2027_q4
    PARTITION OF completed_events
    FOR VALUES FROM ('2027-10-01') TO ('2028-01-01');

CREATE TABLE IF NOT EXISTS completed_events_2028_q1
    PARTITION OF completed_events
    FOR VALUES FROM ('2028-01-01') TO ('2028-04-01');

CREATE TABLE IF NOT EXISTS completed_events_2028_q2
    PARTITION OF completed_events
    FOR VALUES FROM ('2028-04-01') TO ('2028-07-01');

-- 2. Duplicate segment guard
--    Unique constraint: one segment per (group, sequence) prevents double-ingest
ALTER TABLE event_segments
    ADD COLUMN IF NOT EXISTS body_hash TEXT
    GENERATED ALWAYS AS (md5(body::text)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_segs_inprogress_seq_unique
    ON event_segments (in_progress_id, sequence)
    WHERE in_progress_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_segs_completed_seq_unique
    ON event_segments (completed_id, sequence)
    WHERE completed_id IS NOT NULL;

-- Idempotency index: same body hash within the same group prevents exact duplicate events
CREATE UNIQUE INDEX IF NOT EXISTS idx_segs_inprogress_body_unique
    ON event_segments (in_progress_id, body_hash)
    WHERE in_progress_id IS NOT NULL;

-- 3. Covering indexes for the most common query patterns
--    listEvents: filter by policy + status + started_at
CREATE INDEX IF NOT EXISTS idx_ce_policy_status_started
    ON completed_events (policy_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_policy_started
    ON in_progress_events (policy_id, started_at DESC);

--    listEvents: filter by aggregation key within a policy
CREATE INDEX IF NOT EXISTS idx_ce_policy_key_started
    ON completed_events (policy_id, aggregation_key, started_at DESC);

--    stats endpoint: count by status quickly
CREATE INDEX IF NOT EXISTS idx_ce_status_completed_at
    ON completed_events (status, completed_at DESC);

--    performance endpoint: slowest completed groups
CREATE INDEX IF NOT EXISTS idx_ce_duration_desc
    ON completed_events (duration_ms DESC NULLS LAST);

--    in-progress aging
CREATE INDEX IF NOT EXISTS idx_ip_started_at
    ON in_progress_events (started_at ASC);
