#!/usr/bin/env node
// ─── Aggre/Gator SNMP Trap Test Sender ───────────────────────────────────────
// Sends test SNMP traps to the Aggre/Gator receiver.
// Uses the AggreGator MIB OIDs directly.
//
// Usage:
//   node scripts/send-trap.js --list-policies
//   node scripts/send-trap.js --policy <uuid> --key TRD-001 --event-type trade.initiated
//   node scripts/send-trap.js --policy <uuid> --key TRD-001 --event-type trade.initiated \
//     --body '{"notional":100000,"currency":"GBP"}' --severity 4
//   node scripts/send-trap.js --standard linkDown --agent 192.168.1.10
//   node scripts/send-trap.js --scenario trade    # full cradle→middle→grave sequence

const snmp   = require("net-snmp");
const http   = require("http");
const args   = process.argv.slice(2);
const get    = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d; };
const has    = (f) => args.includes(f);

const HOST      = get("--host",      "127.0.0.1");
const PORT      = parseInt(get("--port", "1162"));
const COMMUNITY = get("--community", "public");
const API_BASE  = get("--api",       "http://localhost:3001");

// ── Aggre/Gator MIB OIDs ─────────────────────────────────────────────────────
const OID = {
  sysUpTime:          "1.3.6.1.2.1.1.3.0",
  snmpTrapOID:        "1.3.6.1.6.3.1.1.4.1.0",
  agIngestTrap:       "1.3.6.1.4.1.99999.2.1",
  agPolicyId:         "1.3.6.1.4.1.99999.4.1",
  agAggregationKey:   "1.3.6.1.4.1.99999.4.2",
  agEventType:        "1.3.6.1.4.1.99999.4.3",
  agEventBody:        "1.3.6.1.4.1.99999.4.4",
  agSourceSystem:     "1.3.6.1.4.1.99999.4.5",
  agSeverity:         "1.3.6.1.4.1.99999.4.6",
  // Standard trap OIDs
  linkDown:           "1.3.6.1.6.3.1.1.5.3",
  linkUp:             "1.3.6.1.6.3.1.1.5.4",
  coldStart:          "1.3.6.1.6.3.1.1.5.1",
};

const STANDARD_TRAPS = {
  linkDown: {
    trapOid: OID.linkDown,
    varbinds: [
      { oid: "1.3.6.1.2.1.2.2.1.1", type: snmp.ObjectType.Integer, value: 2 },
      { oid: "1.3.6.1.2.1.2.2.1.2", type: snmp.ObjectType.OctetString, value: "GigabitEthernet0/1" },
      { oid: "1.3.6.1.2.1.2.2.1.8", type: snmp.ObjectType.Integer, value: 2 },  // ifOperStatus=down
    ],
  },
  linkUp: {
    trapOid: OID.linkUp,
    varbinds: [
      { oid: "1.3.6.1.2.1.2.2.1.1", type: snmp.ObjectType.Integer, value: 2 },
      { oid: "1.3.6.1.2.1.2.2.1.2", type: snmp.ObjectType.OctetString, value: "GigabitEthernet0/1" },
      { oid: "1.3.6.1.2.1.2.2.1.8", type: snmp.ObjectType.Integer, value: 1 },  // ifOperStatus=up
    ],
  },
  coldStart: {
    trapOid: OID.coldStart,
    varbinds: [],
  },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}/api/v1${path}`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on("error", reject);
  });
}

function sendTrap(varbinds) {
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(HOST, COMMUNITY, {
      version: snmp.Version2c,
    });

    session.trap(snmp.TrapType.EnterpriseSpecific, varbinds, (err) => {
      session.close();
      if (err) reject(err);
      else resolve(true);
    });
  });
}

function makeAgTrap(policyId, key, eventType, body = {}, severity = -1, sourceSystem = "send-trap.js") {
  const varbinds = [
    { oid: OID.snmpTrapOID,       type: snmp.ObjectType.OID,          value: OID.agIngestTrap },
    { oid: OID.agPolicyId,        type: snmp.ObjectType.OctetString,   value: policyId },
    { oid: OID.agAggregationKey,  type: snmp.ObjectType.OctetString,   value: key },
    { oid: OID.agEventType,       type: snmp.ObjectType.OctetString,   value: eventType },
    { oid: OID.agEventBody,       type: snmp.ObjectType.OctetString,   value: JSON.stringify(body) },
    { oid: OID.agSourceSystem,    type: snmp.ObjectType.OctetString,   value: sourceSystem },
  ];
  if (severity >= 0) {
    varbinds.push({ oid: OID.agSeverity, type: snmp.ObjectType.Integer, value: severity });
  }
  return varbinds;
}

async function main() {
  if (has("--help") || has("-h")) {
    console.log(`
Aggre/Gator SNMP Trap Test Sender

Usage:
  node scripts/send-trap.js [options]

Options:
  --host <ip>           Target host (default: 127.0.0.1)
  --port <n>            Target UDP port (default: 1162)
  --community <str>     SNMP community string (default: public)
  --api <url>           Aggre/Gator API base URL (default: http://localhost:3001)

AggreGator MIB trap:
  --policy <uuid>       Policy UUID to route to (required)
  --key <value>         Aggregation key value
  --event-type <str>    Event type (e.g. trade.initiated)
  --body <json>         Extra JSON payload
  --severity <0-5>      Severity: 0=clear,2=warning,3=minor,4=major,5=critical
  --source <str>        Source system name

Standard traps (for routing rules testing):
  --standard <name>     Send a standard trap: linkDown, linkUp, coldStart
  --agent <ip>          Spoof agent address in varbinds

Scenarios (full event sequences):
  --scenario trade      Sends cradle + 2 middle + grave for a trade lifecycle
  --scenario link       Sends linkDown then linkUp (for routing rule testing)
  --delay <ms>          Delay between scenario steps (default: 500)

Other:
  --list-policies       List active policies from API then exit
  --count <n>           Repeat the trap N times
`);
    return;
  }

  if (has("--list-policies")) {
    const pols = await apiGet("/policies");
    const active = pols.filter(p => p.isActive);
    console.log(`\nActive policies (${active.length}):\n`);
    active.forEach(p => {
      console.log(`  ${p.id}`);
      console.log(`    Name:    ${p.name}`);
      console.log(`    Key:     ${p.keyField}  Cradle: ${p.cradleValue}  Grave: ${p.graveValue}`);
      console.log();
    });
    return;
  }

  const delay = parseInt(get("--delay", "500"));
  const count = parseInt(get("--count", "1"));

  // ── Standard trap ──────────────────────────────────────────────────────────
  const stdTrap = get("--standard", null);
  if (stdTrap) {
    const t = STANDARD_TRAPS[stdTrap];
    if (!t) { console.error(`Unknown standard trap: ${stdTrap}. Options: ${Object.keys(STANDARD_TRAPS).join(", ")}`); process.exit(1); }
    console.log(`Sending ${stdTrap} trap to ${HOST}:${PORT}...`);
    await sendTrap([
      { oid: OID.snmpTrapOID, type: snmp.ObjectType.OID, value: t.trapOid },
      ...t.varbinds,
    ]);
    console.log("✓ Sent");
    return;
  }

  // ── Scenario ───────────────────────────────────────────────────────────────
  const scenario = get("--scenario", null);
  if (scenario) {
    const policyId = get("--policy", null);
    if (!policyId) {
      // Try to pick first active policy
      const pols = await apiGet("/policies");
      const first = pols.find(p => p.isActive);
      if (!first) { console.error("No active policy found. Use --policy <uuid>"); process.exit(1); }
      args.push("--policy", first.id);
    }
    const pid = get("--policy", null);

    if (scenario === "trade") {
      const key = `TRD-TRAP-${Date.now().toString(36).toUpperCase()}`;
      const steps = [
        { eventType: "trade.initiated", body: { notional: 100000, currency: "GBP", instrument: "EQUITY" }, severity: 3 },
        { eventType: "trade.confirmed",  body: { confirmRef: `CNF-${Date.now()}` }, severity: 2 },
        { eventType: "trade.cleared",    body: { clearingRef: `CLR-${Date.now()}` }, severity: 2 },
        { eventType: "trade.settled",    body: { status: "settled", settlementRef: `STL-${Date.now()}` }, severity: 0 },
      ];
      console.log(`\nTrade lifecycle scenario — key: ${key}\n`);
      for (const step of steps) {
        console.log(`  → Sending ${step.eventType}...`);
        await sendTrap(makeAgTrap(pid, key, step.eventType, step.body, step.severity, "send-trap-scenario"));
        console.log(`    ✓ Sent (severity ${step.severity})`);
        if (step !== steps[steps.length - 1]) await sleep(delay);
      }
    } else if (scenario === "link") {
      const key = get("--agent", "192.168.1.10");
      console.log(`\nLink down/up scenario — agent: ${key}\n`);
      console.log("  → Sending linkDown...");
      await sendTrap([{ oid: OID.snmpTrapOID, type: snmp.ObjectType.OID, value: OID.linkDown },
        { oid: "1.3.6.1.2.1.2.2.1.2", type: snmp.ObjectType.OctetString, value: "GigabitEthernet0/1" }]);
      console.log("    ✓ Sent");
      await sleep(delay);
      console.log("  → Sending linkUp...");
      await sendTrap([{ oid: OID.snmpTrapOID, type: snmp.ObjectType.OID, value: OID.linkUp },
        { oid: "1.3.6.1.2.1.2.2.1.2", type: snmp.ObjectType.OctetString, value: "GigabitEthernet0/1" }]);
      console.log("    ✓ Sent");
    } else {
      console.error(`Unknown scenario: ${scenario}. Options: trade, link`);
      process.exit(1);
    }
    console.log("\nDone.");
    return;
  }

  // ── Single AggreGator MIB trap ─────────────────────────────────────────────
  const policyId = get("--policy", null);
  if (!policyId) { console.error("--policy <uuid> is required. Use --list-policies to see options."); process.exit(1); }

  const key       = get("--key",        `KEY-${Date.now()}`);
  const eventType = get("--event-type", "snmp.test");
  const bodyStr   = get("--body",       "{}");
  const severity  = parseInt(get("--severity", "-1"));
  const source    = get("--source",     "send-trap.js");

  let body = {};
  try { body = JSON.parse(bodyStr); } catch { console.error("Invalid --body JSON"); process.exit(1); }

  const varbinds = makeAgTrap(policyId, key, eventType, body, severity, source);

  console.log(`\nSending AggreGator MIB trap to ${HOST}:${PORT}`);
  console.log(`  Policy:     ${policyId}`);
  console.log(`  Key:        ${key}`);
  console.log(`  Event type: ${eventType}`);
  if (severity >= 0) console.log(`  Severity:   ${severity}`);
  console.log();

  for (let i = 0; i < count; i++) {
    const vbs = count > 1 ? makeAgTrap(policyId, key, eventType, { ...body, seq: i+1 }, severity, source) : varbinds;
    await sendTrap(vbs);
    console.log(`  ✓ [${i+1}/${count}] Sent`);
    if (count > 1 && i < count - 1 && delay > 0) await sleep(delay);
  }
  console.log("\nDone.");
}

main().catch(err => { console.error(err.message); process.exit(1); });
