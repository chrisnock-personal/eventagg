#!/usr/bin/env node
// ─── Aggre/Gator SNMP Trap Sender ────────────────────────────────────────────
// Uses raw dgram + BER encoding — no net-snmp dependency, port is always respected.
//
// Usage:
//   node scripts/send-trap.js --list-policies
//   node scripts/send-trap.js --policy <uuid> --key TRD-001 --event-type trade.initiated
//   node scripts/send-trap.js --scenario trade --policy <uuid>
//   node scripts/send-trap.js --scenario trade --policy <uuid> --host <host> --port 1162

const dgram = require("dgram");
const http  = require("http");
const https = require("https");

const args = process.argv.slice(2);
const get  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d; };
const has  = (f) => args.includes(f);

const HOST      = get("--host",      "127.0.0.1");
const PORT      = parseInt(get("--port",  "1162"));
const COMMUNITY = get("--community", "public");
const API_BASE  = get("--api",       "http://localhost:3001");

// ─── AggreGator MIB OIDs ─────────────────────────────────────────────────────
const AG_INGEST_TRAP     = "1.3.6.1.4.1.99999.2.1";
const AG_POLICY_ID       = "1.3.6.1.4.1.99999.4.1";
const AG_AGGREGATION_KEY = "1.3.6.1.4.1.99999.4.2";
const AG_EVENT_TYPE      = "1.3.6.1.4.1.99999.4.3";
const AG_EVENT_BODY      = "1.3.6.1.4.1.99999.4.4";
const AG_SOURCE_SYSTEM   = "1.3.6.1.4.1.99999.4.5";
const AG_SEVERITY        = "1.3.6.1.4.1.99999.4.6";
const SNMP_TRAP_OID      = "1.3.6.1.6.3.1.1.4.1.0";
const SYS_UPTIME         = "1.3.6.1.2.1.1.3.0";

// ─── BER encoding helpers ─────────────────────────────────────────────────────
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
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 0x80) { bytes.push(v); continue; }
    const tmp = [];
    while (v > 0) { tmp.unshift((v & 0x7f) | (tmp.length ? 0x80 : 0)); v >>= 7; }
    bytes.push(...tmp);
  }
  return encTLV(0x06, Buffer.from(bytes));
}
function encNull() { return Buffer.from([0x05, 0x00]); }

function encVarbind(oid, type, value) {
  let valBuf;
  if      (type === "oid")    valBuf = encOid(value);
  else if (type === "int")    valBuf = encInt(value);
  else if (type === "ticks")  valBuf = encTLV(0x43, encInt(value).slice(2));
  else                        valBuf = encOctetStr(String(value));
  return encTLV(0x30, Buffer.concat([encOid(oid), valBuf]));
}

// ─── Build SNMPv2c Trap PDU ───────────────────────────────────────────────────
function buildTrapV2(community, varbinds) {
  // Fixed varbinds: sysUpTime + snmpTrapOID must come first
  const vbBufs = varbinds.map(v => encVarbind(v.oid, v.type || "str", v.value));
  const vbList = encTLV(0x30, Buffer.concat(vbBufs));

  const reqId   = encInt(Math.floor(Math.random() * 0x7fffffff));
  const errStat = encInt(0);
  const errIdx  = encInt(0);

  // PDU type 0xa7 = SNMPv2-Trap-PDU
  const pdu = encTLV(0xa7, Buffer.concat([reqId, errStat, errIdx, vbList]));

  const msg = encTLV(0x30, Buffer.concat([
    encInt(1),                    // version: SNMPv2c = 1
    encOctetStr(community),       // community string
    pdu,
  ]));

  return msg;
}

// ─── Send UDP packet ──────────────────────────────────────────────────────────
function sendUdp(buf, host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.send(buf, 0, buf.length, port, host, (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── Build and send AggreGator MIB trap ──────────────────────────────────────
async function sendAgTrap(policyId, key, eventType, body = {}, severity = -1, source = "send-trap.js") {
  const varbinds = [
    { oid: SYS_UPTIME,         type: "ticks", value: Math.floor(process.uptime() * 100) },
    { oid: SNMP_TRAP_OID,      type: "oid",   value: AG_INGEST_TRAP },
    { oid: AG_POLICY_ID,       type: "str",   value: policyId },
    { oid: AG_AGGREGATION_KEY, type: "str",   value: key },
    { oid: AG_EVENT_TYPE,      type: "str",   value: eventType },
    { oid: AG_EVENT_BODY,      type: "str",   value: JSON.stringify(body) },
    { oid: AG_SOURCE_SYSTEM,   type: "str",   value: source },
  ];
  if (severity >= 0) varbinds.push({ oid: AG_SEVERITY, type: "int", value: severity });

  const pkt = buildTrapV2(COMMUNITY, varbinds);
  await sendUdp(pkt, HOST, PORT);
  return pkt.length;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP helper (for --list-policies) ───────────────────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/api/v1${path}`);
    const lib = url.protocol === "https:" ? https : http;
    http.get(`${API_BASE}/api/v1${path}`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on("error", reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (has("--help") || has("-h")) {
    console.log(`
Aggre/Gator SNMP Trap Sender (raw dgram — no net-snmp required)

Options:
  --host <ip>         Target host (default: 127.0.0.1)
  --port <n>          Target UDP port (default: 1162)
  --community <str>   SNMP community (default: public)
  --api <url>         API base URL for --list-policies (default: http://localhost:3001)

AggreGator MIB trap:
  --policy <uuid>     Policy UUID (required)
  --key <value>       Aggregation key
  --event-type <str>  Event type (e.g. trade.initiated)
  --body <json>       Extra JSON payload
  --severity <0-5>    0=clear 2=warning 3=minor 4=major 5=critical
  --count <n>         Repeat N times

Scenarios:
  --scenario trade    Full trade: cradle + 2 middle + grave
  --scenario link     linkDown + linkUp (standard traps)
  --delay <ms>        Delay between scenario steps (default: 500)

Discovery:
  --list-policies     List active policies from API
`);
    return;
  }

  const delay = parseInt(get("--delay", "500"));

  if (has("--list-policies")) {
    const pols = await apiGet("/policies");
    const active = pols.filter(p => p.isActive);
    console.log(`\nActive policies (${active.length}):\n`);
    active.forEach(p => {
      console.log(`  ${p.id}`);
      console.log(`    Name:    ${p.name}`);
      console.log(`    Key:     ${p.keyField}  Cradle: ${p.cradleValue}  Grave: ${p.graveValue}`);
      if (p.timeoutMs) console.log(`    Timeout: ${p.timeoutMs}ms`);
      console.log();
    });
    return;
  }

  const scenario = get("--scenario", null);

  if (scenario === "trade") {
    const policyId = get("--policy", null);
    if (!policyId) { console.error("--policy <uuid> required"); process.exit(1); }
    const key = `TRD-TRAP-${Date.now().toString(36).toUpperCase()}`;
    const steps = [
      { eventType: "trade.initiated", body: { notional: 100000, currency: "GBP" }, severity: 3 },
      { eventType: "trade.confirmed",  body: { confirmRef: `CNF-${Date.now()}` },   severity: 2 },
      { eventType: "trade.cleared",    body: { clearingRef: `CLR-${Date.now()}` },  severity: 2 },
      { eventType: "trade.settled",    body: { status: "settled" },                 severity: 0 },
    ];
    console.log(`\nTrade scenario → ${HOST}:${PORT}  key: ${key}\n`);
    for (const step of steps) {
      const bytes = await sendAgTrap(policyId, key, step.eventType, step.body, step.severity);
      console.log(`  ✓ ${step.eventType} (${bytes} bytes)`);
      if (step !== steps[steps.length - 1]) await sleep(delay);
    }
    console.log("\nDone.");
    return;
  }

  if (scenario === "link") {
    // Standard linkDown/linkUp using raw BER
    const linkDownOid = "1.3.6.1.6.3.1.1.5.3";
    const linkUpOid   = "1.3.6.1.6.3.1.1.5.4";
    console.log(`\nLink scenario → ${HOST}:${PORT}\n`);
    let pkt = buildTrapV2(COMMUNITY, [
      { oid: SYS_UPTIME,    type: "ticks", value: 1000 },
      { oid: SNMP_TRAP_OID, type: "oid",   value: linkDownOid },
      { oid: "1.3.6.1.2.1.2.2.1.2", type: "str", value: "GigabitEthernet0/1" },
    ]);
    await sendUdp(pkt, HOST, PORT);
    console.log(`  ✓ linkDown (${pkt.length} bytes)`);
    await sleep(delay);
    pkt = buildTrapV2(COMMUNITY, [
      { oid: SYS_UPTIME,    type: "ticks", value: 1100 },
      { oid: SNMP_TRAP_OID, type: "oid",   value: linkUpOid },
      { oid: "1.3.6.1.2.1.2.2.1.2", type: "str", value: "GigabitEthernet0/1" },
    ]);
    await sendUdp(pkt, HOST, PORT);
    console.log(`  ✓ linkUp (${pkt.length} bytes)`);
    console.log("\nDone.");
    return;
  }

  // ── Single trap ──────────────────────────────────────────────────────────
  const policyId = get("--policy", null);
  if (!policyId) { console.error("--policy <uuid> required. Use --list-policies to see options."); process.exit(1); }
  const key       = get("--key",        `KEY-${Date.now()}`);
  const eventType = get("--event-type", "snmp.test");
  const severity  = parseInt(get("--severity", "-1"));
  const count     = parseInt(get("--count", "1"));
  let body = {};
  try { body = JSON.parse(get("--body", "{}")); } catch { console.error("Invalid --body JSON"); process.exit(1); }

  console.log(`\nSending AggreGator trap → ${HOST}:${PORT}`);
  console.log(`  Policy: ${policyId}  Key: ${key}  Type: ${eventType}\n`);

  for (let i = 0; i < count; i++) {
    const b = count > 1 ? { ...body, seq: i + 1 } : body;
    const k = count > 1 ? `${key}-${i+1}` : key;
    const bytes = await sendAgTrap(policyId, k, eventType, b, severity);
    console.log(`  ✓ [${i+1}/${count}] Sent (${bytes} bytes)`);
    if (count > 1 && i < count - 1) await sleep(parseInt(get("--delay", "0")));
  }
  console.log("\nDone.");
}

main().catch(err => { console.error(err.message); process.exit(1); });
