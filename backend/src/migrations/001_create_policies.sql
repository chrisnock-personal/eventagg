-- 001_create_policies.sql
CREATE TABLE IF NOT EXISTS policies (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    domain          TEXT        NOT NULL DEFAULT '*',

    key_field       TEXT        NOT NULL,

    cradle_field    TEXT        NOT NULL,
    cradle_value    TEXT        NOT NULL,

    grave_field     TEXT        NOT NULL,
    grave_value     TEXT        NOT NULL,

    description     TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    updated_by      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_name
    ON policies (name)
    WHERE is_active = TRUE;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_policies_updated_at ON policies;
CREATE TRIGGER trg_policies_updated_at
    BEFORE UPDATE ON policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
