-- 019_add_org_id_columns.sql
-- Multi-tenancy phase 1: add org_id to every tenant-scoped table, backfill
-- existing rows to the Default Organisation, then enforce NOT NULL everywhere
-- it's safe to do so.
--
-- users.org_id and audit_log.org_id stay NULLABLE:
--   - users: the new 'superadmin' role (021) is not tied to any organisation.
--   - audit_log: superadmin actions (e.g. login) must still be logged even
--     though superadmin has no org context; a NOT NULL constraint here would
--     make audit() silently drop those entries (it never throws on failure).
--
-- system_config is intentionally NOT touched -it holds instance-wide config
-- (SMTP settings etc.), not per-tenant data.

DO $$
DECLARE
    default_org_id UUID;
BEGIN
    SELECT id INTO default_org_id FROM organisations WHERE slug = 'default';

    -- ── policies ──────────────────────────────────────────────────────────
    ALTER TABLE policies ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE policies SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE policies ALTER COLUMN org_id SET NOT NULL;

    -- ── users (nullable -see comment above) ─────────────────────────────
    ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE users SET org_id = default_org_id WHERE org_id IS NULL;

    -- ── in_progress_events ────────────────────────────────────────────────
    ALTER TABLE in_progress_events ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE in_progress_events SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE in_progress_events ALTER COLUMN org_id SET NOT NULL;

    -- ── completed_events (partitioned -ADD COLUMN on parent propagates) ──
    ALTER TABLE completed_events ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE completed_events SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE completed_events ALTER COLUMN org_id SET NOT NULL;

    -- ── raw_events ────────────────────────────────────────────────────────
    ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE raw_events SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE raw_events ALTER COLUMN org_id SET NOT NULL;

    -- ── audit_log (nullable -see comment above) ─────────────────────────
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE audit_log SET org_id = default_org_id WHERE org_id IS NULL;

    -- ── webhooks ──────────────────────────────────────────────────────────
    ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE webhooks SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE webhooks ALTER COLUMN org_id SET NOT NULL;

    -- ── webhook_deliveries ────────────────────────────────────────────────
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE webhook_deliveries SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE webhook_deliveries ALTER COLUMN org_id SET NOT NULL;

    -- ── snmp_trap_sources (routing logic itself is a later phase) ───────
    ALTER TABLE snmp_trap_sources ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE snmp_trap_sources SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE snmp_trap_sources ALTER COLUMN org_id SET NOT NULL;

    -- ── snmp_routing_rules ────────────────────────────────────────────────
    ALTER TABLE snmp_routing_rules ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE snmp_routing_rules SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE snmp_routing_rules ALTER COLUMN org_id SET NOT NULL;

    -- ── snmp_trap_log ─────────────────────────────────────────────────────
    ALTER TABLE snmp_trap_log ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id);
    UPDATE snmp_trap_log SET org_id = default_org_id WHERE org_id IS NULL;
    ALTER TABLE snmp_trap_log ALTER COLUMN org_id SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_policies_org           ON policies (org_id);
CREATE INDEX IF NOT EXISTS idx_users_org               ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_ipe_org                 ON in_progress_events (org_id);
CREATE INDEX IF NOT EXISTS idx_ce_org                  ON completed_events (org_id);
CREATE INDEX IF NOT EXISTS idx_re_org                  ON raw_events (org_id);
CREATE INDEX IF NOT EXISTS idx_audit_org               ON audit_log (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhooks_org            ON webhooks (org_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org  ON webhook_deliveries (org_id);
CREATE INDEX IF NOT EXISTS idx_snmp_sources_org        ON snmp_trap_sources (org_id);
CREATE INDEX IF NOT EXISTS idx_snmp_routing_org         ON snmp_routing_rules (org_id);
CREATE INDEX IF NOT EXISTS idx_snmp_log_org            ON snmp_trap_log (org_id);
