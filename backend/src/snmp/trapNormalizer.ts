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
}

// ─── Routing rules cache ──────────────────────────────────────────────────────
let routingRulesCache: RoutingRule[] = [];
let routingCacheAge = 0;

interface RoutingRule {
  id: string;
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
      `SELECT id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field
       FROM snmp_routing_rules WHERE is_active = TRUE ORDER BY priority ASC`
    );
    routingCacheAge = Date.now();
  } catch { /* DB not ready yet */ }
  return routingRulesCache;
}

// ─── Policy keyField cache ────────────────────────────────────────────────────
const policyKeyFieldCache: Record<string, string> = {};

async function getPolicyKeyField(policyId: string): Promise<string | null> {
  if (policyKeyFieldCache[policyId]) return policyKeyFieldCache[policyId];
  try {
    const rows = await query<{ key_field: string }>(
      `SELECT key_field FROM policies WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [policyId]
    );
    if (rows.length > 0) {
      policyKeyFieldCache[policyId] = rows[0].key_field;
      return rows[0].key_field;
    }
  } catch { /* ignore */ }
  return null;
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

  const base: Omit<NormalizedTrap, "routeType" | "ingestInput" | "routedTo"> = {
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
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null };
    }

    // Look up the policy's keyField so we populate the right body property
    const keyField = await getPolicyKeyField(policyId);
    if (!keyField) {
      console.log(`📡  SNMP: policy ${policyId} not found or inactive`);
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null };
    }

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
    return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null };
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
    ingestInput: {
      policyId: matched.policy_id,
      body,
      sourceIp: raw.sourceAddress,
    },
  };
}
