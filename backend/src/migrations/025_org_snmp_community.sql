-- 025_org_snmp_community.sql
-- Reversibility: schema-only -DROP COLUMN fully reverses this, no
-- dependent data.
--
-- Multi-tenancy phase 3: each org gets its own SNMP community string, the
-- primary mechanism for resolving which org an incoming trap belongs to
-- BEFORE any policy/routing-rule lookup (see snmp/trapNormalizer.ts). Unlike
-- ingest_api_key (an app-generated secret), this is admin-editable text —
-- devices already have a community string configured; the admin tells the
-- app what that value already is.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS snmp_community TEXT UNIQUE;

-- Default Organisation keeps 'public' so existing single-tenant deployments
-- (and this app's own SNMP_COMMUNITY=public default) keep working unchanged.
UPDATE organisations SET snmp_community = 'public'
  WHERE slug = 'default' AND snmp_community IS NULL;

-- Any other pre-existing orgs get a random unique placeholder, same
-- convention as ingest_api_key's own DEFAULT -an admin can rename it to
-- something meaningful via the Organizations panel.
UPDATE organisations SET snmp_community = encode(gen_random_bytes(6), 'hex')
  WHERE snmp_community IS NULL;

ALTER TABLE organisations ALTER COLUMN snmp_community SET NOT NULL;
