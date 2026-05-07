-- 003_create_completed_events.sql
CREATE TABLE IF NOT EXISTS completed_events (
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    policy_id           UUID        NOT NULL REFERENCES policies (id),
    aggregation_key     TEXT        NOT NULL,
    key_field           TEXT        NOT NULL,

    segment_count       INT         NOT NULL,
    cradle_segment_id   UUID        NOT NULL,
    grave_segment_id    UUID        NOT NULL,

    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    duration_ms         INT         GENERATED ALWAYS AS (
                            EXTRACT(EPOCH FROM (ended_at - started_at))::INT * 1000
                        ) STORED,

    completed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, completed_at)
) PARTITION BY RANGE (completed_at);

-- Create initial partitions - add more via migrations as time passes
CREATE TABLE IF NOT EXISTS completed_events_2026_q2
    PARTITION OF completed_events
    FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS completed_events_2026_q3
    PARTITION OF completed_events
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');

CREATE TABLE IF NOT EXISTS completed_events_2026_q4
    PARTITION OF completed_events
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS completed_events_2027_q1
    PARTITION OF completed_events
    FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');

CREATE INDEX IF NOT EXISTS idx_ce_policy_key
    ON completed_events (policy_id, aggregation_key);

CREATE INDEX IF NOT EXISTS idx_ce_started_at
    ON completed_events (started_at);

CREATE INDEX IF NOT EXISTS idx_ce_ended_at
    ON completed_events (ended_at);

CREATE INDEX IF NOT EXISTS idx_ce_completed_at
    ON completed_events (completed_at);

CREATE INDEX IF NOT EXISTS idx_ce_duration
    ON completed_events (duration_ms);
