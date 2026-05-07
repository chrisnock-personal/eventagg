-- 004_create_event_segments.sql
CREATE TABLE IF NOT EXISTS event_segments (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    in_progress_id  UUID        REFERENCES in_progress_events (id) ON DELETE SET NULL,
    completed_id    UUID,

    policy_id       UUID        NOT NULL REFERENCES policies (id),
    aggregation_key TEXT        NOT NULL,

    sequence        INT         NOT NULL,
    is_cradle       BOOLEAN     NOT NULL DEFAULT FALSE,
    is_grave        BOOLEAN     NOT NULL DEFAULT FALSE,

    body            JSONB       NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    source_ip       INET,
    ingest_api_key  TEXT
);

CREATE INDEX IF NOT EXISTS idx_segs_in_progress
    ON event_segments (in_progress_id)
    WHERE in_progress_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_segs_completed
    ON event_segments (completed_id)
    WHERE completed_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_segs_policy_key
    ON event_segments (policy_id, aggregation_key);

CREATE INDEX IF NOT EXISTS idx_segs_received_at
    ON event_segments (received_at);

CREATE INDEX IF NOT EXISTS idx_segs_body
    ON event_segments USING GIN (body jsonb_path_ops);

-- Trigger: increment segment_count + update last_seen_at on insert
CREATE OR REPLACE FUNCTION update_group_on_segment_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.in_progress_id IS NOT NULL THEN
        UPDATE in_progress_events
        SET    segment_count = segment_count + 1,
               last_seen_at  = now()
        WHERE  id = NEW.in_progress_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_segment_inserted ON event_segments;
CREATE TRIGGER trg_segment_inserted
    AFTER INSERT ON event_segments
    FOR EACH ROW EXECUTE FUNCTION update_group_on_segment_insert();
