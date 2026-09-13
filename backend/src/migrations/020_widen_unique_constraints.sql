-- 020_widen_unique_constraints.sql
-- Multi-tenancy phase 1: widen uniqueness that was accidentally global to be
-- per-organisation instead. users.username/users.email stay globally unique
-- by design (login is by username alone, no org picker -see plan).

-- ── policies.name: was UNIQUE WHERE is_active, now UNIQUE per org ────────────
DROP INDEX IF EXISTS idx_policies_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_org_name
    ON policies (org_id, name)
    WHERE is_active = TRUE;

-- ── snmp_trap_sources.agent_addr: was globally UNIQUE, now UNIQUE per org ────
ALTER TABLE snmp_trap_sources DROP CONSTRAINT IF EXISTS snmp_trap_sources_agent_addr_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_snmp_sources_org_agent
    ON snmp_trap_sources (org_id, agent_addr);
