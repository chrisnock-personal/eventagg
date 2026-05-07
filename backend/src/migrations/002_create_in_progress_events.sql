-- 002_create_in_progress_events.sql
CREATE TABLE IF NOT EXISTS in_progress_events (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id           UUID        NOT NULL REFERENCES policies (id),
    aggregation_key     TEXT        NOT NULL,
    key_field           TEXT        NOT NULL,

    segment_count       INT         NOT NULL DEFAULT 0,
    cradle_segment_id   UUID,

    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ipe_policy_key
    ON in_progress_events (policy_id, aggregation_key);

CREATE INDEX IF NOT EXISTS idx_ipe_started_at
    ON in_progress_events (started_at);

CREATE INDEX IF NOT EXISTS idx_ipe_expires_at
    ON in_progress_events (expires_at)
    WHERE expires_at IS NOT NULL;
