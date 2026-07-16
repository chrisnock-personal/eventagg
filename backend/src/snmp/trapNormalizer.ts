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
  // Which org this trap belongs to. Resolved from the trap's community
  // string against organisations.snmp_community FIRST (see
  // resolveOrgByCommunity below) — that becomes authoritative for routing,
  // rule scoping, AND log/source attribution even when routeType ends up
  // "unrouted" (no policy/rule match) — a trap from a registered org still
  // shows up in that org's SNMP log even with nothing configured to ingest
  // it yet. Only null when the community string isn't registered to any
  // org at all, in which case routing falls back to legacy (unscoped)
  // behavior for backward compatibility with pre-Phase-3 deployments.
  orgId:       string | null;
}

// ─── Org resolution by SNMP community string ──────────────────────────────────
// Authoritative org boundary for SNMP: matched FIRST, before any policy/rule
// lookup, so a trap from a brand-new source (no routing rule configured yet)
// still gets a real org identity instead of silently falling into the
// Default Organisation. Short-TTL cache, same pattern as the routing rules
// and policy keyField caches below.
const orgByCommunityCache: Record<string, { orgId: string | null; age: number }> = {};

async function resolveOrgByCommunity(community: string): Promise<string | null> {
  const cached = orgByCommunityCache[community];
  if (cached && Date.now() - cached.age < 30_000) return cached.orgId;
  let orgId: string | null = null;
  try {
    const rows = await query<{ id: string }>(
      `SELECT id FROM organisations WHERE snmp_community = $1 AND is_active = TRUE LIMIT 1`,
      [community]
    );
    orgId = rows[0]?.id ?? null;
  } catch { /* DB not ready yet */ }
  orgByCommunityCache[community] = { orgId, age: Date.now() };
  return orgId;
}

// ─── Routing rules cache ──────────────────────────────────────────────────────
// Keyed by org id once a community string resolves one — scopes rule
// matching to that org only, closing a latent cross-tenant bug where a
// broad rule in one org could match a trap actually meant for another org's
// narrower rule. Key "*" is the legacy unscoped fallback for traps whose
// community string doesn't resolve to any org yet.
const routingRulesCache: Record<string, { rules: RoutingRule[]; age: number }> = {};

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

async function getRoutingRules(orgId?: string): Promise<RoutingRule[]> {
  const key = orgId ?? "*";
  const cached = routingRulesCache[key];
  if (cached && Date.now() - cached.age < 30_000) return cached.rules;
  let rules: RoutingRule[] = [];
  try {
    rules = orgId
      ? await query<RoutingRule>(
          `SELECT id, org_id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field
           FROM snmp_routing_rules WHERE org_id = $1 AND is_active = TRUE ORDER BY priority ASC`,
          [orgId]
        )
      : await query<RoutingRule>(
          `SELECT id, org_id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field
           FROM snmp_routing_rules WHERE is_active = TRUE ORDER BY priority ASC`
        );
  } catch { /* DB not ready yet */ }
  routingRulesCache[key] = { rules, age: Date.now() };
  return rules;
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
  for (const key of Object.keys(routingRulesCache)) delete routingRulesCache[key];
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

  // Authoritative org boundary, resolved before any policy/rule lookup.
  // Null means this community string isn't registered to any org yet —
  // callers below fall back to legacy (unscoped) behavior in that case.
  const communityOrgId = await resolveOrgByCommunity(raw.community);

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

    // Even when nothing below ends up routable to a policy, an unrouted
    // trap still gets attributed to whichever org its community string
    // resolves to (or null if truly unrecognised) — that's what makes it
    // visible in the right tenant's SNMP log/sources view instead of
    // silently falling into the Default Organisation. This is the actual
    // point of community-based org resolution: it doesn't depend on a
    // policy/rule match existing at all.
    if (!policyId) {
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: communityOrgId };
    }

    // Look up the policy's keyField (and owning org) so we populate the
    // right body property and know which org this event belongs to
    const policyInfo = await getPolicyKeyField(policyId);
    if (!policyInfo) {
      console.log(`📡  SNMP: policy ${policyId} not found or inactive`);
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: communityOrgId };
    }
    const { keyField, orgId } = policyInfo;

    // The community string identified an org, but this trap's policy
    // belongs to a different one — a real misconfiguration signal (a
    // device sending org A's community string while referencing org B's
    // policy), not something to silently trust the policy's org for.
    // Still attributed to the community's org (not null) so that tenant's
    // admin can actually see the misconfigured trap arrived.
    if (communityOrgId && orgId !== communityOrgId) {
      console.log(`📡  SNMP: policy ${policyId} belongs to a different org than community "${raw.community}" resolves to — dropping as unrouted`);
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: communityOrgId };
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
      orgId,
      ingestInput: { policyId, body, sourceIp: raw.sourceAddress },
    };
  }

  // ── Standard trap — routing rules ─────────────────────────────────────────
  // Scoped to the community-resolved org when one exists, so a trap can only
  // ever match that org's own rules — falls back to the legacy unscoped
  // search only when the community string isn't registered to any org.
  const rules = await getRoutingRules(communityOrgId ?? undefined);
  const matched = rules.find(r => {
    if (r.match_community && r.match_community !== raw.community) return false;
    if (r.match_agent     && r.match_agent     !== raw.sourceAddress) return false;
    if (r.match_trap_oid  && r.match_trap_oid  !== raw.trapOid) return false;
    return true;
  });

  if (!matched) {
    // Same reasoning as the AggreGator-MIB path above: attribute to the
    // community-resolved org even with no rule to actually route through.
    return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: communityOrgId };
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
