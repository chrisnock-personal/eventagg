-- 018_create_organisations.sql
-- Multi-tenancy phase 1: organisations table + a "Default Organisation" that
-- all pre-existing data gets backfilled into (see 019_add_org_id_columns.sql).

-- gen_random_bytes() (used for the ingest API key default) lives in pgcrypto;
-- gen_random_uuid() used everywhere else in this codebase is core Postgres.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organisations (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    slug            TEXT        NOT NULL UNIQUE,
    ingest_api_key  TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_organisations_updated_at ON organisations;
CREATE TRIGGER trg_organisations_updated_at
    BEFORE UPDATE ON organisations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO organisations (name, slug)
VALUES ('Default Organisation', 'default')
ON CONFLICT (slug) DO NOTHING;
