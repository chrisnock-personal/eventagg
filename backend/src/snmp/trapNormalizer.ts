import {
  resolveOid, isAggreGatorTrap,
  AG_POLICY_ID_OID, AG_AGGREGATION_KEY_OID,
  AG_EVENT_TYPE_OID, AG_EVENT_BODY_OID,
  AG_SOURCE_SYSTEM_OID, AG_SEVERITY_OID,
  SEVERITY_NAMES,
} from "./oidMap";
import { query } from "../db/pool";
import { IngestInput } from "../services/ingestService";

export interface RawTrap {
  sourceAddress: string;
  community:     string;
  trapOid:       string;
  uptime:        number;
  varbinds:      Array<{ oid: string; value: unknown; type?: string }>;
  version:       1 | 2;
}

export interface NormalizedTrap {
  agentAddr:   string;
  community:   string;
  trapOid:     string;
  trapName:    string;
  varbinds:    Record<string, unknown>;
  routeType:   "aggregator_mib" | "source_rule" | "community_rule" | "unrouted";
  ingestInput: IngestInput | null;
  routedTo:    string | null;
  // Which org this trap belongs to. Set alongside ingestInput when routed;
  // null when unrouted (SNMP multi-tenant routing itself is a later phase —
  // today every routing rule/policy resolves to the single Default
  // Organisation, but this flows through org-correctly already since it's
  // read from whichever org owns the matched policy/rule).
  orgId:       string | null;
}

// ─── Routing rules cache ──────────────────────────────────────────────────────
let routingRulesCache: RoutingRule[] = [];
let routingCacheAge = 0;

interface RoutingRule {
  id: string;
  org_id: string;
  priority: number;
  match_community: string | null;
  match_agent:     string | null;
  match_trap_oid:  string | null;
  policy_id:       string;
  key_field:       string;
}

async function getRoutingRules(): Promise<RoutingRule[]> {
  if (Date.now() - routingCacheAge < 30_000) return routingRulesCache;
  try {
    routingRulesCache = await query<RoutingRule>(
      `SELECT id, org_id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field
       FROM snmp_routing_rules WHERE is_active = TRUE ORDER BY priority ASC`
    );
    routingCacheAge = Date.now();
  } catch { /* DB not ready yet */ }
  return routingRulesCache;
}

// ─── Policy keyField cache ────────────────────────────────────────────────────
const policyKeyFieldCache: Record<string, { keyField: string; orgId: string }> = {};

async function getPolicyKeyField(policyId: string): Promise<{ keyField: string; orgId: string } | null> {
  if (policyKeyFieldCache[policyId]) return policyKeyFieldCache[policyId];
  try {
    const rows = await query<{ key_field: string; org_id: string }>(
      `SELECT key_field, org_id FROM policies WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [policyId]
    );
    if (rows.length > 0) {
      const result = { keyField: rows[0].key_field, orgId: rows[0].org_id };
      policyKeyFieldCache[policyId] = result;
      return result;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Default org fallback (for logging unrouted traps — see logTrap) ─────────
let defaultOrgIdCache: string | null = null;

export async function getDefaultOrgId(): Promise<string | null> {
  if (defaultOrgIdCache) return defaultOrgIdCache;
  try {
    const rows = await query<{ id: string }>(`SELECT id FROM organisations WHERE slug = 'default' LIMIT 1`);
    if (rows.length > 0) defaultOrgIdCache = rows[0].id;
  } catch { /* ignore */ }
  return defaultOrgIdCache;
}

export function invalidateRoutingCache(): void {
  routingCacheAge = 0;
}

// ─── Main normalizer ──────────────────────────────────────────────────────────

export async function normalizeTrap(raw: RawTrap): Promise<NormalizedTrap> {
  // Build varbind map with human-readable names
  const varbinds: Record<string, unknown> = {};
  for (const vb of raw.varbinds) {
    const name = resolveOid(vb.oid);
    varbinds[name] = vb.value;
  }

  const trapName = resolveOid(raw.trapOid);

  const base: Omit<NormalizedTrap, "routeType" | "ingestInput" | "routedTo" | "orgId"> = {
    agentAddr: raw.sourceAddress,
    community: raw.community,
    trapOid:   raw.trapOid,
    trapName,
    varbinds,
  };

  // ── AggreGator MIB trap ───────────────────────────────────────────────────
  if (isAggreGatorTrap(raw.trapOid)) {
    const policyId     = String(varbinds["agPolicyId"] ?? "");
    const agKey        = String(varbinds["agAggregationKey"] ?? raw.sourceAddress);
    const eventType    = String(varbinds["agEventType"]   ?? "snmp.trap");
    const sourceSystem = String(varbinds["agSourceSystem"] ?? raw.sourceAddress);
    const severityNum  = Number(varbinds["agSeverity"] ?? -1);

    let extraBody: Record<string, unknown> = {};
    const bodyStr = varbinds["agEventBody"];
    if (bodyStr && typeof bodyStr === "string" && bodyStr.trim().startsWith("{")) {
      try { extraBody = JSON.parse(bodyStr); } catch { /* ignore */ }
    }

    if (!policyId) {
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: null };
    }

    // Look up the policy's keyField (and owning org) so we populate the
    // right body property and know which org this event belongs to
    const policyInfo = await getPolicyKeyField(policyId);
    if (!policyInfo) {
      console.log(`📡  SNMP: policy ${policyId} not found or inactive`);
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: null };
    }
    const { keyField, orgId } = policyInfo;

    const body: Record<string, unknown> = {
      ...extraBody,
      eventType,
      agentAddr:    raw.sourceAddress,
      community:    raw.community,
      sourceSystem: sourceSystem || raw.sourceAddress,
      uptime:       raw.uptime,
      ...(severityNum >= 0 ? { severity: SEVERITY_NAMES[severityNum] ?? severityNum } : {}),
    };

    // Set the aggregation key using the policy's actual keyField name
    body[keyField] = agKey;

    return {
      ...base,
      routeType:   "aggregator_mib",
      routedTo:    policyId,
      orgId,
      ingestInput: { policyId, body, sourceIp: raw.sourceAddress },
    };
  }

  // ── Standard trap — routing rules ─────────────────────────────────────────
  const rules = await getRoutingRules();
  const matched = rules.find(r => {
    if (r.match_community && r.match_community !== raw.community) return false;
    if (r.match_agent     && r.match_agent     !== raw.sourceAddress) return false;
    if (r.match_trap_oid  && r.match_trap_oid  !== raw.trapOid) return false;
    return true;
  });

  if (!matched) {
    return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: null };
  }

  const keyValue = (varbinds[matched.key_field] ?? raw.sourceAddress) as string;
  const body: Record<string, unknown> = {
    ...varbinds,
    trapOid:   raw.trapOid,
    trapName,
    agentAddr: raw.sourceAddress,
    community: raw.community,
    uptime:    raw.uptime,
    [matched.key_field]: keyValue,
  };

  const routeType = matched.match_agent ? "source_rule" : "community_rule";

  return {
    ...base,
    routeType,
    routedTo:    matched.policy_id,
    orgId:       matched.org_id,
    ingestInput: {
      policyId: matched.policy_id,
      body,
      sourceIp: raw.sourceAddress,
    },
  };
}
