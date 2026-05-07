-- 005_create_audit_log.sql
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_time      TIMESTAMPTZ NOT NULL DEFAULT now(),

    entity_type     TEXT        NOT NULL,
    entity_id       UUID        NOT NULL,
    action          TEXT        NOT NULL,

    policy_id       UUID        REFERENCES policies (id),
    aggregation_key TEXT,

    actor           TEXT,
    source_ip       INET,

    before_state    JSONB,
    after_state     JSONB,
    metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_entity
    ON audit_log (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_time
    ON audit_log (event_time);

CREATE INDEX IF NOT EXISTS idx_audit_action
    ON audit_log (action);

CREATE INDEX IF NOT EXISTS idx_audit_policy
    ON audit_log (policy_id)
    WHERE policy_id IS NOT NULL;
