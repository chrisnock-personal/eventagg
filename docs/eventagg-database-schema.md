# EventAgg — Database Schema

**PostgreSQL 16+**  
Version: 1.0 · May 2026

---

## Overview

The schema is organised around three concerns that map directly to the platform's architecture:

1. **Policy storage** — the rules that define how events are correlated, when a group opens, and when it closes.
2. **Live event groups** — in-flight groups waiting for their grave condition, stored in a hot, write-optimised table.
3. **Completed event groups** — fully closed groups promoted to a durable, query-optimised table with time-based partitioning.

A fourth table provides an **audit log** of every state transition, required for compliance.

---

## Table Summary

| Table | Purpose | Write pattern |
|---|---|---|
| `policies` | Aggregation policy definitions | Infrequent, admin-driven |
| `in_progress_events` | Open event groups awaiting grave | Frequent reads + writes |
| `event_segments` | Individual segments (normalised) | Insert-only, high volume |
| `completed_events` | Closed event groups (partitioned) | Append-only |
| `audit_log` | State transition history | Insert-only |

---

## 1. `policies`

Stores each named aggregation policy as configured in the UI. Every field maps directly to a property visible in the Policy Editor.

```sql
CREATE TABLE policies (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    domain          TEXT        NOT NULL DEFAULT '*',

    -- Aggregation key: dot-notation path resolved against the segment body
    key_field       TEXT        NOT NULL,

    -- Cradle (start) condition: body.<cradle_field> = cradle_value opens a new group
    cradle_field    TEXT        NOT NULL,
    cradle_value    TEXT        NOT NULL,

    -- Grave (end) condition: body.<grave_field> = grave_value closes the group
    grave_field     TEXT        NOT NULL,
    grave_value     TEXT        NOT NULL,

    description     TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    updated_by      TEXT
);

CREATE UNIQUE INDEX idx_policies_name ON policies (name) WHERE is_active = TRUE;
```

### Notes

- `key_field`, `cradle_field`, and `grave_field` all use dot-notation (e.g. `trade.reference`, `meta.correlationId`). The ingest service resolves these against the segment body JSON at runtime.
- `domain` is a glob pattern (e.g. `user.*`) reserved for future routing — not enforced at the DB level.
- `is_active = FALSE` soft-deletes a policy without breaking the foreign key reference on historical event groups.
- `updated_at` should be maintained by a trigger (see Triggers section).

### Example rows

| name | domain | key_field | cradle_field | cradle_value | grave_field | grave_value |
|---|---|---|---|---|---|---|
| User Session | `user.*` | `sessionId` | `eventType` | `user.login` | `eventType` | `user.logout` |
| Trade Lifecycle | `trade.*` | `tradeRef` | `eventType` | `trade.initiated` | `status` | `settled` |
| Order Flow | `order.*` | `orderId` | `eventType` | `order.created` | `eventType` | `order.delivered` |
| API Request/Response | `api.*` | `correlationId` | `eventType` | `api.request` | `eventType` | `api.response` |

---

## 2. `in_progress_events`

Holds every event group from the moment its cradle segment is observed until its grave segment promotes it to `completed_events`. This table is the hot path — every ingest write touches it.

```sql
CREATE TABLE in_progress_events (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id           UUID        NOT NULL REFERENCES policies (id),
    aggregation_key     TEXT        NOT NULL,
    key_field           TEXT        NOT NULL,   -- denormalised for display; source: policy.key_field

    segment_count       INT         NOT NULL DEFAULT 0,
    cradle_segment_id   UUID,                   -- FK set after first segment insert (see event_segments)
    
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,            -- optional TTL: auto-grave if no grave received by this time

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookup: find an open group by policy + key on every ingest
CREATE UNIQUE INDEX idx_ipe_policy_key
    ON in_progress_events (policy_id, aggregation_key);

CREATE INDEX idx_ipe_started_at   ON in_progress_events (started_at);
CREATE INDEX idx_ipe_expires_at   ON in_progress_events (expires_at)
    WHERE expires_at IS NOT NULL;
```

### Notes

- The `UNIQUE` index on `(policy_id, aggregation_key)` is the most important index in the schema. It enforces that only one open group can exist per policy per key at any time, and makes the ingest lookup an O(log n) index seek rather than a table scan.
- Segments are stored in the normalised `event_segments` table (see below) rather than as a JSONB array on this row. This keeps the `in_progress_events` row small and avoids row-level lock contention on high-frequency appends to the same group.
- `expires_at` supports a future TTL feature: a background worker can query `WHERE expires_at < now()` to auto-close stale groups.
- `last_seen_at` is updated on every segment append, useful for monitoring and TTL calculations.

---

## 3. `event_segments`

All individual event segments — whether belonging to an in-progress or completed group — are stored here as immutable rows. This is a pure insert-only table.

```sql
CREATE TABLE event_segments (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Group membership: one of these will be non-null
    in_progress_id  UUID        REFERENCES in_progress_events (id) ON DELETE SET NULL,
    completed_id    UUID,       -- references completed_events.id (no FK: partitioned table)

    policy_id       UUID        NOT NULL REFERENCES policies (id),
    aggregation_key TEXT        NOT NULL,

    sequence        INT         NOT NULL,   -- ordinal position within the group (1-based)
    is_cradle       BOOLEAN     NOT NULL DEFAULT FALSE,
    is_grave        BOOLEAN     NOT NULL DEFAULT FALSE,

    body            JSONB       NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Source metadata
    source_ip       INET,
    ingest_api_key  TEXT        -- hashed identifier of the producing client
);

CREATE INDEX idx_segs_in_progress  ON event_segments (in_progress_id)
    WHERE in_progress_id IS NOT NULL;

CREATE INDEX idx_segs_completed    ON event_segments (completed_id)
    WHERE completed_id IS NOT NULL;

CREATE INDEX idx_segs_policy_key   ON event_segments (policy_id, aggregation_key);
CREATE INDEX idx_segs_received_at  ON event_segments (received_at);

-- GIN index for body field queries, e.g. ?body[userId]=u001
CREATE INDEX idx_segs_body         ON event_segments USING GIN (body jsonb_path_ops);
```

### Notes

- Segments are intentionally **not** embedded as a JSONB array inside the event group rows. Normalising them into their own table means:
  - No row bloat or update amplification on the group row for every append.
  - The `body` GIN index is per-segment, making field-level queries efficient without scanning entire group payloads.
  - Individual segments can be queried, paginated, and audited independently.
- `completed_id` does not carry a foreign key constraint because `completed_events` is a partitioned table and Postgres does not enforce FK references across partition boundaries. Referential integrity is enforced at the application layer.
- `sequence` is assigned by the ingest service at write time (max sequence for the group + 1, within a transaction).
- `is_cradle` and `is_grave` are set by the ingest service after evaluating the policy conditions, and stored for fast retrieval — avoids re-evaluating the condition on every read.

---

## 4. `completed_events`

The durable store for fully closed event groups. It is append-only — rows are never updated after insertion. Partitioned by month on `completed_at` to support efficient time-range queries and future archival.

```sql
CREATE TABLE completed_events (
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
                            EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                        ) STORED,

    completed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, completed_at)   -- partition key must be in PK
) PARTITION BY RANGE (completed_at);

-- Partition per quarter for POC; move to monthly when volume grows
CREATE TABLE completed_events_2026_q2
    PARTITION OF completed_events
    FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');

CREATE TABLE completed_events_2026_q3
    PARTITION OF completed_events
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');

-- Indexes are created per-partition automatically when defined on the parent
CREATE INDEX idx_ce_policy_key   ON completed_events (policy_id, aggregation_key);
CREATE INDEX idx_ce_started_at   ON completed_events (started_at);
CREATE INDEX idx_ce_ended_at     ON completed_events (ended_at);
CREATE INDEX idx_ce_completed_at ON completed_events (completed_at);
CREATE INDEX idx_ce_duration     ON completed_events (duration_ms);
```

### Notes

- `duration_ms` is a generated column — computed automatically from `started_at` and `ended_at` and stored physically. This means duration-based queries (e.g. "show me all groups that took longer than 60 seconds") are index-scannable without a runtime calculation.
- Partitions should be created in advance by a scheduled job or migration script. A missing partition for the current period will cause inserts to fail.
- At POC scale (tens to hundreds of thousands of records) quarterly partitions are sufficient. Move to monthly partitioning when rows exceed ~5 million per partition.
- Segments belonging to a completed group remain in `event_segments` with their `completed_id` set — the completed group row itself does not embed segment data, keeping rows narrow for fast aggregation queries.

---

## 5. `audit_log`

An append-only record of every state transition in the system. Required for compliance and never modified or deleted.

```sql
CREATE TABLE audit_log (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_time      TIMESTAMPTZ NOT NULL DEFAULT now(),

    entity_type     TEXT        NOT NULL,  -- 'event_group' | 'segment' | 'policy'
    entity_id       UUID        NOT NULL,
    action          TEXT        NOT NULL,  -- see Action Values below
    
    policy_id       UUID        REFERENCES policies (id),
    aggregation_key TEXT,

    actor           TEXT,                  -- API key identifier or system process name
    source_ip       INET,

    before_state    JSONB,                 -- snapshot of row before change (null for inserts)
    after_state     JSONB,                 -- snapshot of row after change (null for deletes)
    metadata        JSONB                  -- freeform context (e.g. request_id, reason)
);

CREATE INDEX idx_audit_entity     ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_event_time ON audit_log (event_time);
CREATE INDEX idx_audit_action     ON audit_log (action);
CREATE INDEX idx_audit_policy     ON audit_log (policy_id) WHERE policy_id IS NOT NULL;
```

### Action Values

| Action | Triggered by |
|---|---|
| `group.opened` | Cradle segment received; new `in_progress_events` row created |
| `segment.appended` | Intermediate segment added to an open group |
| `group.promoted` | Grave segment received; group moved to `completed_events` |
| `group.expired` | TTL worker auto-closed a group that never received a grave |
| `group.deleted` | Soft-delete API call (marks deleted, excluded from queries) |
| `policy.created` | New policy saved via UI or API |
| `policy.updated` | Existing policy modified |
| `policy.deactivated` | Policy soft-deleted |

---

## Promotion Transaction

When a grave segment is received, the ingest service executes the following atomically. Nothing is committed unless all steps succeed.

```sql
BEGIN;

-- 1. Lock the in-progress group (prevents concurrent grave processing)
SELECT id, started_at, segment_count
FROM   in_progress_events
WHERE  policy_id = $policy_id
AND    aggregation_key = $aggregation_key
FOR UPDATE;

-- 2. Insert the grave segment
INSERT INTO event_segments
    (in_progress_id, completed_id, policy_id, aggregation_key, sequence, is_grave, body, received_at)
VALUES
    ($group_id, NULL, $policy_id, $aggregation_key, $next_sequence, TRUE, $body, now())
RETURNING id INTO $grave_segment_id;

-- 3. Insert into completed_events
INSERT INTO completed_events
    (policy_id, aggregation_key, key_field, segment_count,
     cradle_segment_id, grave_segment_id, started_at, ended_at)
VALUES
    ($policy_id, $aggregation_key, $key_field, $segment_count + 1,
     $cradle_segment_id, $grave_segment_id, $started_at, now())
RETURNING id INTO $completed_id;

-- 4. Re-point all segments from in_progress to completed
UPDATE event_segments
SET    in_progress_id = NULL,
       completed_id   = $completed_id
WHERE  in_progress_id = $group_id;

-- 5. Remove from in_progress
DELETE FROM in_progress_events WHERE id = $group_id;

-- 6. Write audit entry
INSERT INTO audit_log (entity_type, entity_id, action, policy_id, aggregation_key, actor)
VALUES ('event_group', $completed_id, 'group.promoted', $policy_id, $aggregation_key, $actor);

COMMIT;
```

---

## Triggers

### Auto-update `updated_at` on policies

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policies_updated_at
    BEFORE UPDATE ON policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### Auto-update `last_seen_at` and `segment_count` on segment insert

```sql
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

CREATE TRIGGER trg_segment_inserted
    AFTER INSERT ON event_segments
    FOR EACH ROW EXECUTE FUNCTION update_group_on_segment_insert();
```

---

## Indexes Summary

| Table | Index | Type | Purpose |
|---|---|---|---|
| `policies` | `idx_policies_name` | B-tree (partial) | Unique active policy name |
| `in_progress_events` | `idx_ipe_policy_key` | B-tree (unique) | Primary ingest lookup |
| `in_progress_events` | `idx_ipe_started_at` | B-tree | Time-range queries |
| `in_progress_events` | `idx_ipe_expires_at` | B-tree (partial) | TTL worker |
| `event_segments` | `idx_segs_in_progress` | B-tree (partial) | Fetch segments for open group |
| `event_segments` | `idx_segs_completed` | B-tree (partial) | Fetch segments for closed group |
| `event_segments` | `idx_segs_policy_key` | B-tree | Cross-group segment queries |
| `event_segments` | `idx_segs_received_at` | B-tree | Time-range queries |
| `event_segments` | `idx_segs_body` | GIN | Body field value filtering |
| `completed_events` | `idx_ce_policy_key` | B-tree | Key lookup on closed groups |
| `completed_events` | `idx_ce_started_at` | B-tree | Time-range queries |
| `completed_events` | `idx_ce_ended_at` | B-tree | Time-range queries |
| `completed_events` | `idx_ce_completed_at` | B-tree | Partition pruning + recency |
| `completed_events` | `idx_ce_duration` | B-tree | Duration-based queries |
| `audit_log` | `idx_audit_entity` | B-tree | Entity history lookup |
| `audit_log` | `idx_audit_event_time` | B-tree | Time-range audit queries |
| `audit_log` | `idx_audit_action` | B-tree | Filter by action type |

---

## Compliance Considerations

**WAL archiving** — enable in `postgresql.conf`:

```
wal_level = replica
archive_mode = on
archive_command = 'wal-g wal-push %p'   -- or equivalent for your storage target
```

**Retention** — the `audit_log` and `completed_events` tables must not have rows deleted without explicit authorisation. Enforce via role permissions:

```sql
-- Application role: cannot delete from compliance tables
REVOKE DELETE ON audit_log        FROM eventagg_app;
REVOKE DELETE ON completed_events FROM eventagg_app;
REVOKE UPDATE ON audit_log        FROM eventagg_app;

-- Admin role: can delete with explicit grant (for authorised data removal)
GRANT  DELETE ON audit_log        TO eventagg_admin;
GRANT  DELETE ON completed_events TO eventagg_admin;
```

**Row-level timestamps** — every table carries `created_at` at minimum; `completed_events` and `audit_log` are fully immutable after insert. This supports point-in-time reconstruction of system state for any historical moment.

---

## Entity Relationship Diagram

```
policies
    │
    ├──< in_progress_events (policy_id)
    │           │
    │           └──< event_segments (in_progress_id)  ──┐
    │                                                    │ on promotion,
    ├──< completed_events (policy_id)                    │ re-pointed to
    │           │                                        │ completed_id
    │           └──< event_segments (completed_id) ──────┘
    │
    └──< audit_log (policy_id)
```

---

*EventAgg Platform · Database Schema v1.0 · May 2026*
