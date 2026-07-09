ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS event_sequence_number INTEGER;
