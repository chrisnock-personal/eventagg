-- 016_rename_segments_to_raw_events.sql
-- Rename event_segments → raw_events and all related columns/indexes/triggers.

-- ── Rename table ──────────────────────────────────────────────────────────────
ALTER TABLE event_segments RENAME TO raw_events;

-- ── Rename indexes (not auto-renamed on table rename) ─────────────────────────
ALTER INDEX IF EXISTS idx_segs_in_progress            RENAME TO idx_re_in_progress;
ALTER INDEX IF EXISTS idx_segs_completed              RENAME TO idx_re_completed;
ALTER INDEX IF EXISTS idx_segs_policy_key             RENAME TO idx_re_policy_key;
ALTER INDEX IF EXISTS idx_segs_received_at            RENAME TO idx_re_received_at;
ALTER INDEX IF EXISTS idx_segs_body                   RENAME TO idx_re_body;
ALTER INDEX IF EXISTS idx_segs_inprogress_seq_unique  RENAME TO idx_re_inprogress_seq_unique;
ALTER INDEX IF EXISTS idx_segs_completed_seq_unique   RENAME TO idx_re_completed_seq_unique;
ALTER INDEX IF EXISTS idx_segs_inprogress_body_unique RENAME TO idx_re_inprogress_body_unique;

-- ── Drop old trigger and function ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_segment_inserted ON raw_events;
DROP FUNCTION IF EXISTS update_group_on_segment_insert();

-- ── Recreate trigger and function with updated names and column references ────
CREATE OR REPLACE FUNCTION update_group_on_raw_event_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.in_progress_id IS NOT NULL THEN
        UPDATE in_progress_events
        SET    raw_event_count = raw_event_count + 1,
               last_seen_at   = now()
        WHERE  id = NEW.in_progress_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_raw_event_inserted ON raw_events;
CREATE TRIGGER trg_raw_event_inserted
    AFTER INSERT ON raw_events
    FOR EACH ROW EXECUTE FUNCTION update_group_on_raw_event_insert();

-- ── Rename columns in in_progress_events ─────────────────────────────────────
ALTER TABLE in_progress_events RENAME COLUMN segment_count     TO raw_event_count;
ALTER TABLE in_progress_events RENAME COLUMN cradle_segment_id TO cradle_raw_event_id;
ALTER TABLE in_progress_events RENAME COLUMN last_segment_at   TO last_raw_event_at;

ALTER INDEX IF EXISTS idx_in_progress_last_segment_at
    RENAME TO idx_in_progress_last_raw_event_at;

-- ── Rename columns in completed_events ───────────────────────────────────────
ALTER TABLE completed_events RENAME COLUMN segment_count     TO raw_event_count;
ALTER TABLE completed_events RENAME COLUMN cradle_segment_id TO cradle_raw_event_id;
ALTER TABLE completed_events RENAME COLUMN grave_segment_id  TO grave_raw_event_id;
