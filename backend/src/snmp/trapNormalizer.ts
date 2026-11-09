import { resolveOid, isAggreGatorTrap, SEVERITY_NAMES } from "./oidMap";
import { query } from "../db/pool";
import { IngestInput } from "../services/ingestService";
import { logger } from "../logger";

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
  routeType:   "aggregator_mib" | "source_rule" | "community_rule" | "unrouted" | "rejected";
  ingestInput: IngestInput | null;
  routedTo:    string | null;
  // Which org this trap belongs to. Resolved from the trap's community
  // string against organisations.snmp_community FIRST (see
  // resolveOrgByCommunity below) -that becomes authoritative for routing,
  // rule scoping, AND log/source attribution even when routeType ends up
  // "unrouted" (no policy/rule match) -a trap from a registered org still
  // shows up in that org's SNMP log even with nothing configured to ingest
  // it yet. Null only for routeType "rejected": the community string isn't
  // registered to any active org, so the trap is not ingested or logged.
  // (It used to fall back to an unscoped routing search, which let any
  // community string -i.e. no credential at all- ingest into any org whose
  // policy UUID or rule it could name.)
  orgId:       string | null;
}

// ─── Org resolution by SNMP community string ──────────────────────────────────
// Authoritative org boundary for SNMP: matched FIRST, before any policy/rule
// lookup, so a trap from a brand-new source (no routing rule configured yet)
// still gets a real org identity instead of silently falling into the
// Default Organisation. Short-TTL cache, same pattern as the routing rules
// and policy keyField caches below.
// Only hits are cached: caching misses would let a sender grow this map
// without bound by spraying random community strings. A miss is one indexed
// lookup on a UNIQUE column.
const orgByCommunityCache: Record<string, { orgId: string; age: number }> = {};

async function resolveOrgByCommunity(community: string): Promise<string | null> {
  if (!community) return null;
  const cached = orgByCommunityCache[community];
  if (cached && Date.now() - cached.age < 30_000) return cached.orgId;
  try {
    const rows = await query<{ id: string }>(
      `SELECT id FROM organisations WHERE snmp_community = $1 AND is_active = TRUE LIMIT 1`,
      [community]
    );
    const orgId = rows[0]?.id ?? null;
    if (orgId) orgByCommunityCache[community] = { orgId, age: Date.now() };
    return orgId;
  } catch {
    return null; // DB not ready yet
  }
}

export function invalidateCommunityCache(): void {
  for (const key of Object.keys(orgByCommunityCache)) delete orgByCommunityCache[key];
}

// ─── Routing rules cache ──────────────────────────────────────────────────────
// Keyed by org id: rule matching is always scoped to the org the
// community string resolved to, so a broad rule in one org can never match
// a trap meant for another org.
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

async function getRoutingRules(orgId: string): Promise<RoutingRule[]> {
  const cached = routingRulesCache[orgId];
  if (cached && Date.now() - cached.age < 30_000) return cached.rules;
  let rules: RoutingRule[] = [];
  try {
    rules = await query<RoutingRule>(
      `SELECT id, org_id, priority, match_community, match_agent, match_trap_oid, policy_id, key_field
       FROM snmp_routing_rules WHERE org_id = $1 AND is_active = TRUE ORDER BY priority ASC`,
      [orgId]
    );
  } catch { /* DB not ready yet */ }
  routingRulesCache[orgId] = { rules, age: Date.now() };
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

  // Authoritative org boundary, resolved before any policy/rule lookup. The
  // community string is SNMPv2c's only credential, so an unregistered one is
  // rejected outright: not ingested, not logged.
  const communityOrgId = await resolveOrgByCommunity(raw.community);
  if (!communityOrgId) {
    return { ...base, routeType: "rejected", ingestInput: null, routedTo: null, orgId: null };
  }

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
    // resolves to (or null if truly unrecognised) -that's what makes it
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
      logger.info({ policyId }, "📡  SNMP: policy not found or inactive");
      return { ...base, routeType: "unrouted", ingestInput: null, routedTo: null, orgId: communityOrgId };
    }
    const { keyField, orgId } = policyInfo;

    // The community string identified an org, but this trap's policy
    // belongs to a different one -a real misconfiguration signal (a
    // device sending org A's community string while referencing org B's
    // policy), not something to silently trust the policy's org for.
    // Still attributed to the community's org (not null) so that tenant's
    // admin can actually see the misconfigured trap arrived.
    if (orgId !== communityOrgId) {
      logger.warn({ policyId, community: raw.community }, "📡  SNMP: policy belongs to a different org than community resolves to -dropping as unrouted");
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

  // ── Standard trap -routing rules ─────────────────────────────────────────
  // Scoped to the community-resolved org: a trap can only match its own
  // org's rules.
  const rules = await getRoutingRules(communityOrgId);
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
