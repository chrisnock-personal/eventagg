// ─── OID to human-readable name map ─────────────────────────────────────────
// Covers the most common standard traps so they display meaningfully
// in the Aggre/Gator UI without requiring full MIB loading.
// Enterprise-specific OIDs will appear as their raw dotted string.

export const OID_NAMES: Record<string, string> = {
  // ── SNMPv2-MIB standard traps ─────────────────────────────────────────────
  "1.3.6.1.6.3.1.1.5.1": "coldStart",
  "1.3.6.1.6.3.1.1.5.2": "warmStart",
  "1.3.6.1.6.3.1.1.5.3": "linkDown",
  "1.3.6.1.6.3.1.1.5.4": "linkUp",
  "1.3.6.1.6.3.1.1.5.5": "authenticationFailure",
  "1.3.6.1.6.3.1.1.5.6": "egpNeighborLoss",

  // ── Aggre/Gator MIB ───────────────────────────────────────────────────────
  "1.3.6.1.4.1.99999.2.1": "agIngestTrap",

  // ── Aggre/Gator varbind OIDs ──────────────────────────────────────────────
  "1.3.6.1.4.1.99999.4.1": "agPolicyId",
  "1.3.6.1.4.1.99999.4.2": "agAggregationKey",
  "1.3.6.1.4.1.99999.4.3": "agEventType",
  "1.3.6.1.4.1.99999.4.4": "agEventBody",
  "1.3.6.1.4.1.99999.4.5": "agSourceSystem",
  "1.3.6.1.4.1.99999.4.6": "agSeverity",
  "1.3.6.1.4.1.99999.4.7": "agForwardedTrapOid",

  // ── IF-MIB varbinds ───────────────────────────────────────────────────────
  "1.3.6.1.2.1.2.2.1.1":  "ifIndex",
  "1.3.6.1.2.1.2.2.1.2":  "ifDescr",
  "1.3.6.1.2.1.2.2.1.3":  "ifType",
  "1.3.6.1.2.1.2.2.1.5":  "ifSpeed",
  "1.3.6.1.2.1.2.2.1.7":  "ifAdminStatus",
  "1.3.6.1.2.1.2.2.1.8":  "ifOperStatus",

  // ── RFC1213-MIB / system group ────────────────────────────────────────────
  "1.3.6.1.2.1.1.1.0":    "sysDescr",
  "1.3.6.1.2.1.1.2.0":    "sysObjectID",
  "1.3.6.1.2.1.1.3.0":    "sysUpTime",
  "1.3.6.1.2.1.1.4.0":    "sysContact",
  "1.3.6.1.2.1.1.5.0":    "sysName",
  "1.3.6.1.2.1.1.6.0":    "sysLocation",

  // ── SNMPv2-MIB varbinds ───────────────────────────────────────────────────
  "1.3.6.1.6.3.1.1.4.1.0": "snmpTrapOID",
  "1.3.6.1.6.3.1.1.4.3.0": "snmpTrapEnterprise",
  "1.3.6.1.2.1.11.1.0":    "snmpInPkts",

  // ── UPS-MIB (RFC 1628) — common in data centre monitoring ─────────────────
  "1.3.6.1.2.1.33.1.6.3.1": "upsTrapOnBattery",
  "1.3.6.1.2.1.33.1.6.3.2": "upsTrapLowBattery",
  "1.3.6.1.2.1.33.1.6.3.3": "upsTrapBatteryNormal",
  "1.3.6.1.2.1.33.1.6.3.4": "upsTrapCommunicationsLost",
  "1.3.6.1.2.1.33.1.6.3.5": "upsTrapCommunicationsEstablished",

  // ── Entity-MIB (RFC 2737) ─────────────────────────────────────────────────
  "1.3.6.1.2.1.47.2.0.1":  "entConfigChange",

  // ── OSPF-MIB ─────────────────────────────────────────────────────────────
  "1.3.6.1.2.1.14.16.2.1": "ospfIfStateChange",
  "1.3.6.1.2.1.14.16.2.2": "ospfVirtIfStateChange",
  "1.3.6.1.2.1.14.16.2.3": "ospfNbrStateChange",
};

export const AGGRE_GATOR_ENTERPRISE_OID = "1.3.6.1.4.1.99999";
export const AG_INGEST_TRAP_OID         = "1.3.6.1.4.1.99999.2.1";
export const AG_POLICY_ID_OID           = "1.3.6.1.4.1.99999.4.1";
export const AG_AGGREGATION_KEY_OID     = "1.3.6.1.4.1.99999.4.2";
export const AG_EVENT_TYPE_OID          = "1.3.6.1.4.1.99999.4.3";
export const AG_EVENT_BODY_OID          = "1.3.6.1.4.1.99999.4.4";
export const AG_SOURCE_SYSTEM_OID       = "1.3.6.1.4.1.99999.4.5";
export const AG_SEVERITY_OID            = "1.3.6.1.4.1.99999.4.6";

export const SEVERITY_NAMES: Record<number, string> = {
  0: "clear",
  1: "indeterminate",
  2: "warning",
  3: "minor",
  4: "major",
  5: "critical",
};

export function resolveOid(oid: string): string {
  // Strip trailing .0 instance suffix for lookup
  const base = oid.replace(/\.0$/, "");
  return OID_NAMES[base] ?? OID_NAMES[oid] ?? oid;
}

export function isAggreGatorTrap(trapOid: string): boolean {
  return trapOid === AG_INGEST_TRAP_OID ||
         trapOid.startsWith(AGGRE_GATOR_ENTERPRISE_OID);
}
