#!/usr/bin/env node
// ─── Aggre/Gator SNMP Trap Bridge ────────────────────────────────────────────
// Run this DIRECTLY on the host (not inside the container).
// It listens for SNMP traps on UDP and forwards them to the Aggre/Gator
// HTTP ingest API. This sidesteps all container UDP networking issues.
//
// Usage:
//   node scripts/snmp-bridge.js
//   node scripts/snmp-bridge.js --port 1162 --api http://localhost:3001
//   node scripts/snmp-bridge.js --port 162   # requires sudo
//
// Install deps (on the host):
//   npm install net-snmp   (in the project dir)

const dgram = require("dgram");
const http  = require("http");
const https = require("https");

const args    = process.argv.slice(2);
const get     = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d; };

const UDP_PORT  = parseInt(get("--port",      "1162"));
const API_BASE  = get("--api",                "http://localhost:3001");
const COMMUNITY = get("--community",          "public");
const VERBOSE   = args.includes("--verbose");

// ─── BER/ASN.1 SNMPv2c parser ────────────────────────────────────────────────
function parseTrap(buf, sourceAddr) {
  let p = 0;
  const rb    = ()  => buf[p++];
  const rl    = ()  => { const b=rb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|rb(); return l; };
  const rtlv  = ()  => { const tag=rb(); const len=rl(); const data=buf.slice(p,p+len); p+=len; return {tag,data}; };
  const toOid = (b) => {
    const parts=[Math.floor(b[0]/40),b[0]%40]; let v=0;
    for(let i=1;i<b.length;i++){ v=(v<<7)|(b[i]&0x7f); if(!(b[i]&0x80)){parts.push(v);v=0;} }
    return parts.join(".");
  };
  const toInt = (b) => { let v=0; for(let i=0;i<b.length;i++) v=v*256+b[i]; return v; };

  try {
    if(rb()!==0x30) return null; rl();
    rtlv(); // version
    const comm = rtlv().data.toString("ascii");
    const pduTLV = rtlv();
    if(pduTLV.tag!==0xa7 && pduTLV.tag!==0xa4) return null;

    const pb=pduTLV.data; let pp=0;
    const prb   = ()  => pb[pp++];
    const prl   = ()  => { const b=prb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|prb(); return l; };
    const prtlv = ()  => { const tag=prb(); const len=prl(); const data=pb.slice(pp,pp+len); pp+=len; return {tag,data}; };

    prtlv(); prtlv(); prtlv(); // reqId, errStatus, errIdx
    prb(); prl(); // varbindList SEQUENCE tag+length only

    let trapOid=""; let uptime=0;
    const varbinds = {};

    while(pp<pb.length) {
      if(pb[pp]!==0x30) break;
      const vbSeq = prtlv(); // consume entire varbind SEQUENCE
      let vp = 0;
      const vrb  = () => vbSeq.data[vp++];
      const vrl  = () => { const b=vrb(); if(b<0x80) return b; const n=b&0x7f; let l=0; for(let i=0;i<n;i++) l=(l<<8)|vrb(); return l; };
      const vrtlv= () => { const tag=vrb(); const len=vrl(); const data=vbSeq.data.slice(vp,vp+len); vp+=len; return {tag,data}; };
      const oidT = vrtlv();
      const valT = vrtlv();
      const oid=toOid(oidT.data);
      if(oid==="1.3.6.1.2.1.1.3.0")          { uptime=toInt(valT.data); }
      else if(oid==="1.3.6.1.6.3.1.1.4.1.0") { trapOid=toOid(valT.data); }
      else {
        const name = OID_NAMES[oid] ?? OID_NAMES[oid.replace(/\.0$/,"")] ?? oid;
        const val  = valT.tag===0x04 ? valT.data.toString("utf8")
                   : valT.tag===0x06 ? toOid(valT.data)
                   : valT.tag===0x02 ? toInt(valT.data)
                   : valT.data.toString("hex");
        varbinds[name] = val;
      }
    }
    if(!trapOid) return null;

    return { sourceAddress: sourceAddr, community: comm||COMMUNITY, trapOid, uptime, varbinds };
  } catch(e) {
    if(VERBOSE) console.error("Parse error:", e.message);
    return null;
  }
}

// ─── OID name map ─────────────────────────────────────────────────────────────
const OID_NAMES = {
  "1.3.6.1.6.3.1.1.5.1":    "coldStart",
  "1.3.6.1.6.3.1.1.5.2":    "warmStart",
  "1.3.6.1.6.3.1.1.5.3":    "linkDown",
  "1.3.6.1.6.3.1.1.5.4":    "linkUp",
  "1.3.6.1.6.3.1.1.5.5":    "authenticationFailure",
  "1.3.6.1.4.1.99999.2.1":  "agIngestTrap",
  "1.3.6.1.4.1.99999.4.1":  "agPolicyId",
  "1.3.6.1.4.1.99999.4.2":  "agAggregationKey",
  "1.3.6.1.4.1.99999.4.3":  "agEventType",
  "1.3.6.1.4.1.99999.4.4":  "agEventBody",
  "1.3.6.1.4.1.99999.4.5":  "agSourceSystem",
  "1.3.6.1.4.1.99999.4.6":  "agSeverity",
  "1.3.6.1.2.1.2.2.1.1":    "ifIndex",
  "1.3.6.1.2.1.2.2.1.2":    "ifDescr",
  "1.3.6.1.2.1.2.2.1.8":    "ifOperStatus",
  "1.3.6.1.2.1.1.5.0":      "sysName",
};

const TRAP_NAMES = {
  "1.3.6.1.6.3.1.1.5.1": "coldStart",
  "1.3.6.1.6.3.1.1.5.2": "warmStart",
  "1.3.6.1.6.3.1.1.5.3": "linkDown",
  "1.3.6.1.6.3.1.1.5.4": "linkUp",
  "1.3.6.1.4.1.99999.2.1": "agIngestTrap",
};

const AG_ENTERPRISE = "1.3.6.1.4.1.99999";

// ─── HTTP POST to Aggre/Gator ingest API ─────────────────────────────────────
function postIngest(policyId, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ policyId, body });
    const url     = new URL(`${API_BASE}/api/v1/events/ingest`);
    const lib     = url.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol==="https:"?443:80),
      path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Process incoming trap ────────────────────────────────────────────────────
async function handleTrap(trap) {
  const trapName = TRAP_NAMES[trap.trapOid] ?? trap.trapOid;
  console.log(`\n📡  Trap received from ${trap.sourceAddress}`);
  console.log(`    OID:  ${trap.trapOid} (${trapName})`);
  if(VERBOSE) console.log(`    Vars: ${JSON.stringify(trap.varbinds)}`);

  // ── AggreGator MIB trap ──────────────────────────────────────────────────
  if(trap.trapOid === "1.3.6.1.4.1.99999.2.1" || trap.trapOid.startsWith(AG_ENTERPRISE)) {
    const policyId  = trap.varbinds["agPolicyId"];
    const agKey     = trap.varbinds["agAggregationKey"] ?? trap.sourceAddress;
    const eventType = trap.varbinds["agEventType"]      ?? "snmp.trap";
    const sourceSystem = trap.varbinds["agSourceSystem"] ?? trap.sourceAddress;
    const severityNum  = parseInt(trap.varbinds["agSeverity"] ?? "-1");

    let extraBody = {};
    const bodyStr = trap.varbinds["agEventBody"];
    if(bodyStr && bodyStr.startsWith("{")) { try { extraBody = JSON.parse(bodyStr); } catch {} }

    if(!policyId) { console.log("    ⚠ No agPolicyId varbind — unrouted"); return; }

    const body = { ...extraBody, eventType, aggregationKey: agKey, agentAddr: trap.sourceAddress, community: trap.community, sourceSystem, uptime: trap.uptime };
    if(severityNum >= 0) body.severity = ["clear","indeterminate","warning","minor","major","critical"][severityNum] ?? severityNum;

    try {
      const res = await postIngest(policyId, body);
      if(res.status === 200 || res.status === 201) {
        console.log(`    ✓ Ingested → ${res.body.action} | key=${res.body.aggregationKey}`);
      } else {
        console.log(`    ✗ Ingest failed: HTTP ${res.status} — ${res.body?.error ?? res.body}`);
      }
    } catch(e) { console.log(`    ✗ HTTP error: ${e.message}`); }
    return;
  }

  // ── Standard trap — log it (add routing rules via API to ingest these) ───
  console.log(`    ℹ Standard trap — not routed (add an SNMP routing rule to ingest)`);
  if(VERBOSE) console.log(`    Varbinds:`, trap.varbinds);
}

// ─── UDP server ───────────────────────────────────────────────────────────────
const server = dgram.createSocket({ type: "udp4", reuseAddr: true });

server.on("error", err => {
  console.error(`❌  UDP error: ${err.message}`);
  if(err.code === "EACCES") console.error(`   Port ${UDP_PORT} requires root. Try: sudo node scripts/snmp-bridge.js`);
  process.exit(1);
});

server.on("message", async (msg, rinfo) => {
  if(VERBOSE) console.log(`Raw UDP: ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
  const trap = parseTrap(msg, rinfo.address);
  if(!trap) {
    console.log(`⚠  Could not parse UDP packet from ${rinfo.address} (${msg.length} bytes) — not SNMPv2c`);
    return;
  }
  await handleTrap(trap).catch(e => console.error("Handle error:", e.message));
});

server.bind({ port: UDP_PORT, address: "0.0.0.0" }, () => {
  console.log(`\n🐊  Aggre/Gator SNMP Trap Bridge`);
  console.log(`    Listening: UDP 0.0.0.0:${UDP_PORT}`);
  console.log(`    Forwarding to: ${API_BASE}`);
  console.log(`    Community: ${COMMUNITY}`);
  console.log(`\n    Test with:`);
  console.log(`    node scripts/send-trap.js --host <this-ip> --port ${UDP_PORT} --scenario trade --policy <uuid>\n`);
});

process.on("SIGINT",  () => { server.close(); console.log("\nStopped."); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
