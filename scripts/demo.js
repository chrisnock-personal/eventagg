#!/usr/bin/env node
// ─── Aggre/Gator Interactive Demo ────────────────────────────────────────────
// Walks through 4 scenarios showing cradle/middle/grave event arrival.
// Press ENTER at each step to send the next event individually.
//
// Usage:
//   node scripts/demo.js
//   node scripts/demo.js --host <host> --port 1162 --api http://<host>:3001
//   node scripts/demo.js --api-key <ingest-api-key>

const dgram    = require("dgram");
const http     = require("http");
const https    = require("https");
const readline = require("readline");

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has  = (f) => args.includes(f);

const SNMP_HOST = get("--host",      "127.0.0.1");
const SNMP_PORT = parseInt(get("--port", "1162"));
const COMMUNITY = get("--community", "public");
const API_BASE  = get("--api",       "http://localhost:3001");
const API_KEY   = get("--api-key",   null);

if (has("--help") || has("-h")) {
  console.log(`
Aggre/Gator Interactive Demo

Options:
  --host <ip>       SNMP target host         (default: 127.0.0.1)
  --port <n>        SNMP target UDP port      (default: 1162)
  --community <str> SNMP community string     (default: public)
  --api <url>       API base URL              (default: http://localhost:3001)
  --api-key <key>   X-API-Key for HTTP ingest (optional if INGEST_API_KEY unset)

Scenarios:
  1  Trade Lifecycle   -4 steps via SNMP
  2  Network Link      -2 steps via SNMP
  3  Order Lifecycle   -5 steps via HTTP
  4  Telephone Call    -8 steps via HTTP  (requires migration 014)
  5  Out-of-Order      -5 steps via HTTP  (sequence numbers arrive scrambled: 1,4,3,2,5)
  a  All scenarios in sequence
`);
  process.exit(0);
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  red:     "\x1b[31m",
  gray:    "\x1b[90m",
};
const bold    = s => `${C.bold}${s}${C.reset}`;
const green   = s => `${C.green}${s}${C.reset}`;
const yellow  = s => `${C.yellow}${s}${C.reset}`;
const cyan    = s => `${C.cyan}${s}${C.reset}`;
const gray    = s => `${C.gray}${s}${C.reset}`;
const red     = s => `${C.red}${s}${C.reset}`;
const magenta = s => `${C.magenta}${s}${C.reset}`;

// ─── Interactive pause ────────────────────────────────────────────────────────
function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(gray("  Press ENTER to send..."), () => { rl.close(); resolve(); });
  });
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ─── BER encoding (SNMPv2c) ───────────────────────────────────────────────────
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function encTLV(tag, data) {
  return Buffer.concat([Buffer.from([tag]), encLen(data.length), data]);
}
function encInt(n) {
  const b = [];
  let v = n;
  do { b.unshift(v & 0xff); v >>= 8; } while (v > 0);
  if (b[0] & 0x80) b.unshift(0);
  return encTLV(0x02, Buffer.from(b));
}
function encOctetStr(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
  return encTLV(0x04, b);
}
function encOid(oidStr) {
  const parts = oidStr.split(".").map(Number);
  const bytes  = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 0x80) { bytes.push(v); continue; }
    const tmp = [];
    while (v > 0) { tmp.unshift((v & 0x7f) | (tmp.length ? 0x80 : 0)); v >>= 7; }
    bytes.push(...tmp);
  }
  return encTLV(0x06, Buffer.from(bytes));
}
function encVarbind(oid, type, value) {
  let valBuf;
  if      (type === "oid")   valBuf = encOid(value);
  else if (type === "int")   valBuf = encInt(value);
  else if (type === "ticks") valBuf = encTLV(0x43, encInt(value).slice(2));
  else                       valBuf = encOctetStr(String(value));
  return encTLV(0x30, Buffer.concat([encOid(oid), valBuf]));
}
function buildTrapV2(community, varbinds) {
  const vbBufs = varbinds.map(v => encVarbind(v.oid, v.type || "str", v.value));
  const vbList = encTLV(0x30, Buffer.concat(vbBufs));
  const reqId  = encInt(Math.floor(Math.random() * 0x7fffffff));
  const pdu    = encTLV(0xa7, Buffer.concat([reqId, encInt(0), encInt(0), vbList]));
  return encTLV(0x30, Buffer.concat([encInt(1), encOctetStr(community), pdu]));
}

// ─── AggreGator MIB OIDs ──────────────────────────────────────────────────────
const AG_INGEST_TRAP     = "1.3.6.1.4.1.99999.2.1";
const AG_POLICY_ID       = "1.3.6.1.4.1.99999.4.1";
const AG_AGGREGATION_KEY = "1.3.6.1.4.1.99999.4.2";
const AG_EVENT_TYPE      = "1.3.6.1.4.1.99999.4.3";
const AG_EVENT_BODY      = "1.3.6.1.4.1.99999.4.4";
const AG_SOURCE_SYSTEM   = "1.3.6.1.4.1.99999.4.5";
const AG_SEVERITY        = "1.3.6.1.4.1.99999.4.6";
const SNMP_TRAP_OID      = "1.3.6.1.6.3.1.1.4.1.0";
const SYS_UPTIME         = "1.3.6.1.2.1.1.3.0";

// ─── UDP send ─────────────────────────────────────────────────────────────────
function sendUdp(buf, host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.send(buf, 0, buf.length, port, host, err => {
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

async function sendAgTrap(policyId, key, eventType, body = {}, severity = -1) {
  const varbinds = [
    { oid: SYS_UPTIME,         type: "ticks", value: Math.floor(process.uptime() * 100) },
    { oid: SNMP_TRAP_OID,      type: "oid",   value: AG_INGEST_TRAP },
    { oid: AG_POLICY_ID,       type: "str",   value: policyId },
    { oid: AG_AGGREGATION_KEY, type: "str",   value: key },
    { oid: AG_EVENT_TYPE,      type: "str",   value: eventType },
    { oid: AG_EVENT_BODY,      type: "str",   value: JSON.stringify(body) },
    { oid: AG_SOURCE_SYSTEM,   type: "str",   value: "demo.js" },
  ];
  if (severity >= 0) varbinds.push({ oid: AG_SEVERITY, type: "int", value: severity });
  const pkt = buildTrapV2(COMMUNITY, varbinds);
  await sendUdp(pkt, SNMP_HOST, SNMP_PORT);
  return pkt.length;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${API_BASE}/api/v1${path}`);
    const lib     = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (API_KEY)  headers["X-API-Key"]       = API_KEY;
    if (payload)  headers["Content-Length"]  = Buffer.byteLength(payload);

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
    }, res => {
      let d = "";
      res.on("data", chunk => d += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiGet(path)        { return apiRequest("GET",  path); }
async function apiPost(path, body) { return apiRequest("POST", path, body); }

async function ingestEvent(policyId, body, sequenceNumber) {
  const payload = { policyId, body };
  if (sequenceNumber !== undefined) payload.sequenceNumber = sequenceNumber;
  const res = await apiPost("/events/ingest", payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Ingest failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ─── Policy lookup ────────────────────────────────────────────────────────────
async function findPolicy(name) {
  const res = await apiGet("/policies");
  if (res.status !== 200) throw new Error(`Could not fetch policies (${res.status})`);
  return (res.body || []).find(p => p.name === name && p.isActive) || null;
}

// ─── Display helpers ──────────────────────────────────────────────────────────
const HR = gray("─".repeat(62));

function stepHeader({ step, total, role, eventType, key, policyName, transport, seqNum, note }) {
  const roleLabel = role === "CRADLE" ? green(`[CRADLE]`) :
                    role === "GRAVE"  ? red(`[GRAVE ]`) :
                                       yellow(`[MIDDLE]`);
  console.log(`\n${HR}`);
  console.log(`  ${bold(`Step ${step}/${total}`)}  ${roleLabel}  ${bold(eventType)}`);
  console.log(`  ${gray("Policy:")}     ${policyName}`);
  console.log(`  ${gray("Key:")}        ${cyan(key)}`);
  console.log(`  ${gray("Transport:")}  ${transport}`);
  if (seqNum !== undefined) console.log(`  ${gray("Seq #:")}      ${magenta(`#${seqNum}`)}`);
  if (note)                 console.log(`  ${gray("Note:")}       ${note}`);
  console.log(HR);
}

function stepOk(transport, detail) {
  console.log(`  ${green("✓")} Sent via ${transport}  ${gray(detail)}`);
}

// ─── Scenario 1: Trade Lifecycle -SNMP ──────────────────────────────────────
async function scenarioTrade(policy) {
  const key = `TRD-${Date.now().toString(36).toUpperCase()}`;
  const transport = `SNMP → ${SNMP_HOST}:${SNMP_PORT}`;

  // Grave fires on body.status === "settled" (not eventType -see policy seed)
  const steps = [
    {
      role: "CRADLE", eventType: "trade.initiated",
      body: { tradeRef: key, notional: 2_500_000, currency: "GBP", counterparty: "DEMO-BANK" },
      severity: 3,
    },
    {
      role: "MIDDLE", eventType: "trade.confirmed",
      body: { tradeRef: key, confirmRef: `CNF-${Date.now()}`, desk: "FX" },
      severity: 2,
    },
    {
      role: "MIDDLE", eventType: "trade.cleared",
      body: { tradeRef: key, clearingRef: `CLR-${Date.now()}`, ccp: "LCH" },
      severity: 2,
    },
    {
      role: "GRAVE", eventType: "trade.settled",
      body: { tradeRef: key, status: "settled", settlementDate: new Date().toISOString().slice(0, 10) },
      severity: 0,
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    const { role, eventType, body, severity } = steps[i];
    stepHeader({ step: i + 1, total: steps.length, role, eventType, key, policyName: policy.name, transport });
    await waitForEnter();
    const bytes = await sendAgTrap(policy.id, key, eventType, body, severity);
    stepOk("SNMP", `${bytes} bytes`);
  }
}

// ─── Scenario 2: Network Link -SNMP ─────────────────────────────────────────
async function scenarioLink() {
  const transport  = `SNMP → ${SNMP_HOST}:${SNMP_PORT}`;
  const iface      = "GigabitEthernet0/1";
  const linkDownOid = "1.3.6.1.6.3.1.1.5.3";
  const linkUpOid   = "1.3.6.1.6.3.1.1.5.4";

  const steps = [
    { role: "CRADLE", label: "linkDown", oid: linkDownOid, ticks: 5000 },
    { role: "GRAVE",  label: "linkUp",   oid: linkUpOid,   ticks: 6100 },
  ];

  for (let i = 0; i < steps.length; i++) {
    const { role, label, oid, ticks } = steps[i];
    const roleLabel = role === "CRADLE" ? green(`[CRADLE]`) : red(`[GRAVE ]`);
    console.log(`\n${HR}`);
    console.log(`  ${bold(`Step ${i + 1}/${steps.length}`)}  ${roleLabel}  ${bold(label)}`);
    console.log(`  ${gray("Interface:")}  ${iface}`);
    console.log(`  ${gray("Transport:")}  ${transport}`);
    console.log(`  ${gray("Note:")}       Standard MIB-II trap -no AggreGator policy required`);
    console.log(HR);
    await waitForEnter();
    const pkt = buildTrapV2(COMMUNITY, [
      { oid: SYS_UPTIME,    type: "ticks", value: ticks },
      { oid: SNMP_TRAP_OID, type: "oid",   value: oid },
      { oid: "1.3.6.1.2.1.2.2.1.2", type: "str", value: iface },
    ]);
    await sendUdp(pkt, SNMP_HOST, SNMP_PORT);
    stepOk("SNMP", `${pkt.length} bytes`);
  }
}

// ─── Scenario 3: Order Lifecycle -HTTP ──────────────────────────────────────
async function scenarioOrder(policy) {
  const key = `ORD-${Date.now().toString(36).toUpperCase()}`;
  const transport = `HTTP → ${API_BASE}`;

  const steps = [
    {
      role: "CRADLE", eventType: "order.created",
      body: { orderId: key, customer: "ACME Corp", items: 3, total: 1247.50, currency: "GBP" },
    },
    {
      role: "MIDDLE", eventType: "order.processing",
      body: { orderId: key, warehouseId: "WH-NORTH", pickedBy: "OP-042" },
    },
    {
      role: "MIDDLE", eventType: "order.dispatched",
      body: { orderId: key, carrier: "DHL", trackingRef: `DHL${Date.now()}` },
    },
    {
      role: "MIDDLE", eventType: "order.out-for-delivery",
      body: { orderId: key, driver: "D-881", eta: "14:30" },
    },
    {
      role: "GRAVE", eventType: "order.delivered",
      body: { orderId: key, signedBy: "J. Smith", proofRef: `POD-${Date.now()}` },
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    const { role, eventType, body } = steps[i];
    stepHeader({ step: i + 1, total: steps.length, role, eventType, key, policyName: policy.name, transport });
    await waitForEnter();
    const result = await ingestEvent(policy.id, { ...body, eventType });
    stepOk("HTTP", `action=${result.action}  group=${(result.groupId || "").slice(0, 8)}…`);
  }
}

// ─── Scenario 4: Telephone Call -HTTP ───────────────────────────────────────
async function scenarioCall(policy) {
  const key       = `CALL-${Date.now().toString(36).toUpperCase()}`;
  const transport = `HTTP → ${API_BASE}`;
  const callerNum = "+44 20 7123 4567";
  const calleeNum = "+44 20 7890 1234";

  const steps = [
    {
      role: "CRADLE", eventType: "call.invite",
      body: { callId: key, caller: callerNum, callee: calleeNum, codec: "G.711", protocol: "SIP/2.0" },
    },
    {
      role: "MIDDLE", eventType: "call.ringing",
      body: { callId: key, sipCode: 180 },
    },
    {
      role: "MIDDLE", eventType: "call.trying",
      body: { callId: key, sipCode: 100 },
    },
    {
      role: "MIDDLE", eventType: "call.answered",
      body: { callId: key, sipCode: 200, answerMs: 3200 },
    },
    {
      role: "MIDDLE", eventType: "call.media",
      body: { callId: key, rtpPort: 16384, codec: "G.711", jitterMs: 4, packetLoss: 0.0 },
    },
    {
      role: "MIDDLE", eventType: "call.hold",
      body: { callId: key, holdBy: callerNum, reason: "customer-consultation" },
    },
    {
      role: "MIDDLE", eventType: "call.conference",
      body: { callId: key, addedParty: "+44 20 7555 0000", parties: 3, bridgeId: `BRG-${Date.now()}` },
    },
    {
      role: "GRAVE", eventType: "call.ended",
      body: { callId: key, durationMs: 185000, terminatedBy: callerNum, sipCode: 200, reason: "normal-clearing" },
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    const { role, eventType, body } = steps[i];
    stepHeader({ step: i + 1, total: steps.length, role, eventType, key, policyName: policy.name, transport });
    await waitForEnter();
    const result = await ingestEvent(policy.id, { ...body, eventType });
    stepOk("HTTP", `action=${result.action}  group=${(result.groupId || "").slice(0, 8)}…`);
  }
}

// ─── Scenario 5: Out-of-Order Events -HTTP ──────────────────────────────────
// True sequence: created(1) → processing(2) → dispatched(3) → out-for-delivery(4) → delivered(5)
// Arrival order:        1  →           4    →         3     →         2            →       5
// Steps 2-4 arrive scrambled, simulating delayed messages from distributed microservices.
async function scenarioOutOfOrder(policy) {
  const key       = `ORD-OOO-${Date.now().toString(36).toUpperCase()}`;
  const transport = `HTTP → ${API_BASE}`;

  const steps = [
    {
      role: "CRADLE", eventType: "order.created", seqNum: 1,
      body: { orderId: key, customer: "GlobalCo Ltd", items: 7, total: 3892.00, currency: "USD" },
      note: "Emitted by order-service -arrives first (in order)",
    },
    {
      role: "MIDDLE", eventType: "order.out-for-delivery", seqNum: 4,
      body: { orderId: key, driver: "D-214", eta: "16:45", vehicleId: "VAN-099" },
      note: yellow(`⚠  true position #4 -delayed delivery-service message arrives 2nd`),
    },
    {
      role: "MIDDLE", eventType: "order.dispatched", seqNum: 3,
      body: { orderId: key, carrier: "FastShip", trackingRef: `FSP-${Date.now()}`, depot: "NW-1" },
      note: yellow(`⚠  true position #3 -buffered carrier-service message arrives 3rd`),
    },
    {
      role: "MIDDLE", eventType: "order.processing", seqNum: 2,
      body: { orderId: key, warehouseId: "WH-SOUTH", pickedBy: "OP-118", lane: "B4" },
      note: yellow(`⚠  true position #2 -most delayed, warehouse-service arrives 4th`),
    },
    {
      role: "GRAVE", eventType: "order.delivered", seqNum: 5,
      body: { orderId: key, signedBy: "R. Patel", proofRef: `POD-${Date.now()}` },
      note: "Emitted by delivery-service -arrives last (in order)",
    },
  ];

  console.log();
  console.log(gray(`  Arrival order:  created(#1)  →  out-for-delivery(#4)  →  dispatched(#3)  →  processing(#2)  →  delivered(#5)`));
  console.log(gray(`  True order:     created(#1)  →  processing(#2)        →  dispatched(#3)  →  out-for-delivery(#4)  →  delivered(#5)`));
  console.log(gray(`  In the UI: open the group and toggle "# Sort by Seq" to see true event order`));

  for (let i = 0; i < steps.length; i++) {
    const { role, eventType, body, seqNum, note } = steps[i];
    stepHeader({ step: i + 1, total: steps.length, role, eventType, key, policyName: policy.name, transport, seqNum, note });
    await waitForEnter();
    const result = await ingestEvent(policy.id, { ...body, eventType }, seqNum);
    stepOk("HTTP", `action=${result.action}  group=${(result.groupId || "").slice(0, 8)}…  seq=#${seqNum}`);
  }
}

// ─── Scenario menu ────────────────────────────────────────────────────────────
async function scenarioMenu(callAvailable) {
  console.log();
  console.log(bold("  Select a scenario:"));
  console.log();
  console.log(`  ${cyan("1")}  Trade Lifecycle     ${gray("(4 steps · SNMP)")}`);
  console.log(`  ${cyan("2")}  Network Link        ${gray("(2 steps · SNMP)")}`);
  console.log(`  ${cyan("3")}  Order Lifecycle     ${gray("(5 steps · HTTP)")}`);
  if (callAvailable) {
    console.log(`  ${cyan("4")}  Telephone Call      ${gray("(8 steps · HTTP)")}`);
  } else {
    console.log(`  ${gray("4")}  ${gray("Telephone Call      (deploy migration 014 to enable)")}`);
  }
  console.log(`  ${cyan("5")}  Out-of-Order Events ${gray("(5 steps · HTTP · sequence numbers)")}`);
  console.log(`  ${cyan("a")}  All in sequence`);
  console.log(`  ${cyan("q")}  Quit`);
  console.log();
  return prompt(gray("  Choice: "));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(bold("╔════════════════════════════════════════════════════╗"));
  console.log(bold("║         Aggre/Gator  - Interactive Demo           ║"));
  console.log(bold("╚════════════════════════════════════════════════════╝"));
  console.log();
  console.log(`  SNMP:  ${cyan(`${SNMP_HOST}:${SNMP_PORT}`)}`);
  console.log(`  API:   ${cyan(API_BASE)}`);
  if (API_KEY) console.log(`  Key:   ${gray("[set]")}`);
  console.log();

  process.stdout.write(gray("  Fetching policies from API... "));

  let tradePol, orderPol, callPol;
  try {
    [tradePol, orderPol, callPol] = await Promise.all([
      findPolicy("EXAMPLE - Trade Lifecycle"),
      findPolicy("EXAMPLE - Order Flow"),
      findPolicy("DEMO - Telephone Call"),
    ]);
  } catch (err) {
    console.log(red("failed"));
    console.log(red(`  ${err.message}`));
    console.log(red("  Is the API reachable? Try --api http://<host>:3001"));
    process.exit(1);
  }

  const coreOk = tradePol && orderPol;
  if (coreOk) {
    console.log(green("ok"));
  } else {
    console.log(red("missing"));
    if (!tradePol) console.log(red(`  ✗ "EXAMPLE - Trade Lifecycle" not found`));
    if (!orderPol) console.log(red(`  ✗ "EXAMPLE - Order Flow" not found`));
    console.log(red("  Are the seed migrations applied? Is the container running?"));
    process.exit(1);
  }
  if (callPol) {
    console.log(`  ${green("✓")} Telephone Call policy found`);
  } else {
    console.log(`  ${yellow("!")} Telephone Call policy not found -deploy migration 014 to enable scenario 4`);
  }

  while (true) {
    const choice = await scenarioMenu(!!callPol);
    if (choice === "q" || choice === "") break;

    const runTrade = async () => {
      console.log(`\n${magenta(bold("━━━  Scenario 1: Trade Lifecycle  (SNMP)  ━━━"))}`);
      console.log(gray("  4-step FX trade · each event delivered as an SNMP v2c trap"));
      await scenarioTrade(tradePol);
      console.log(`\n  ${green("✓")} Trade scenario complete.\n`);
    };

    const runLink = async () => {
      console.log(`\n${magenta(bold("━━━  Scenario 2: Network Link  (SNMP)  ━━━"))}`);
      console.log(gray("  Standard MIB-II linkDown → linkUp · no AggreGator policy needed"));
      await scenarioLink();
      console.log(`\n  ${green("✓")} Link scenario complete.\n`);
    };

    const runOrder = async () => {
      console.log(`\n${magenta(bold("━━━  Scenario 3: Order Lifecycle  (HTTP)  ━━━"))}`);
      console.log(gray("  5-step order from placement to delivery · events via REST API"));
      await scenarioOrder(orderPol);
      console.log(`\n  ${green("✓")} Order scenario complete.\n`);
    };

    const runCall = async () => {
      if (!callPol) {
        console.log(red("\n  Telephone Call policy not found. Deploy migration 014 and restart the container.\n"));
        return;
      }
      console.log(`\n${magenta(bold("━━━  Scenario 4: Telephone Call  (HTTP)  ━━━"))}`);
      console.log(gray("  SIP-style call: INVITE → RINGING → TRYING → ANSWERED → MEDIA → HOLD → CONFERENCE → BYE"));
      await scenarioCall(callPol);
      console.log(`\n  ${green("✓")} Telephone Call scenario complete.\n`);
    };

    const runOutOfOrder = async () => {
      console.log(`\n${magenta(bold("━━━  Scenario 5: Out-of-Order Events  (HTTP)  ━━━"))}`);
      console.log(gray("  5 order events from distributed microservices -arrive as seqNums 1,4,3,2,5"));
      console.log(gray("  Open the group in the UI and toggle \"# Sort by Seq\" to reveal true order"));
      await scenarioOutOfOrder(orderPol);
      console.log(`\n  ${green("✓")} Out-of-Order scenario complete.\n`);
    };

    try {
      if      (choice === "1") await runTrade();
      else if (choice === "2") await runLink();
      else if (choice === "3") await runOrder();
      else if (choice === "4") await runCall();
      else if (choice === "5") await runOutOfOrder();
      else if (choice === "a") { await runTrade(); await runLink(); await runOrder(); await runCall(); await runOutOfOrder(); }
      else console.log(yellow("\n  Unknown choice -enter 1, 2, 3, 4, 5, a, or q.\n"));
    } catch (err) {
      console.log(red(`\n  Error: ${err.message}\n`));
    }
  }

  console.log(gray("\n  Bye.\n"));
}

main().catch(err => { console.error(red(err.message)); process.exit(1); });
