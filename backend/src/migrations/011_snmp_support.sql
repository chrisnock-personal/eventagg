-- ── 011: SNMP trap receiver support ─────────────────────────────────────────

-- Registered trap sources (known agents)
CREATE TABLE IF NOT EXISTS snmp_trap_sources (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  agent_addr  TEXT        NOT NULL UNIQUE,  -- IP address of the SNMP agent
  community   TEXT        NOT NULL DEFAULT 'public',
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  last_seen   TIMESTAMPTZ,
  trap_count  BIGINT      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Community-to-policy routing rules (fallback for non-AggreGator traps)
CREATE TABLE IF NOT EXISTS snmp_routing_rules (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  priority        INTEGER NOT NULL DEFAULT 100,
  -- Match criteria (all present fields must match; NULL = wildcard)
  match_community TEXT,                    -- e.g. 'public', 'monitoring'
  match_agent     TEXT,                    -- e.g. '192.168.1.10'
  match_trap_oid  TEXT,                    -- e.g. '1.3.6.1.6.3.1.1.5.3'
  -- Routing
  policy_id       UUID    NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  key_field       TEXT    NOT NULL DEFAULT 'sourceIp',  -- which field in body to use as aggregation key
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snmp_routing_priority ON snmp_routing_rules (priority ASC);
CREATE INDEX IF NOT EXISTS idx_snmp_sources_agent    ON snmp_trap_sources   (agent_addr);

-- Recent raw traps log (ring buffer -trimmed to last 1000)
CREATE TABLE IF NOT EXISTS snmp_trap_log (
  id          BIGSERIAL   PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_addr  TEXT        NOT NULL,
  community   TEXT        NOT NULL,
  trap_oid    TEXT        NOT NULL,
  trap_name   TEXT,
  varbinds    JSONB       NOT NULL DEFAULT '{}',
  routed_to   UUID        REFERENCES policies(id) ON DELETE SET NULL,
  route_type  TEXT,       -- 'aggregator_mib' | 'source_rule' | 'community_rule' | 'unrouted'
  ingest_result JSONB
);

CREATE INDEX IF NOT EXISTS idx_snmp_log_received ON snmp_trap_log (received_at DESC);
