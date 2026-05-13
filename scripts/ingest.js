#!/usr/bin/env node
// ─── Aggre/Gator Ingest CLI ───────────────────────────────────────────────────
// Usage:
//   node scripts/ingest.js --policy <uuid> --body '{"eventType":"trade.initiated","tradeRef":"T-001"}'
//   node scripts/ingest.js --policy <uuid> --file ./event.json
//   node scripts/ingest.js --policy <uuid> --body '...' --count 50 --delay 100
//   node scripts/ingest.js --list-policies
//
// Options:
//   --api       Base URL (default: http://localhost:3001)
//   --policy    Policy UUID to ingest against
//   --body      JSON string for the event body
//   --file      Path to a JSON file (single event or array of events)
//   --count     How many times to repeat the event (default: 1)
//   --delay     ms delay between events when --count > 1 (default: 0)
//   --key       Override the aggregation key value in the body (shortcut)
//   --list-policies  Fetch and print all active policies then exit

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const has  = (flag) => args.includes(flag);

const BASE_URL   = get("--api")    || process.env.AGGREGATOR_URL || "http://localhost:3001";
const POLICY_ID  = get("--policy") || process.env.AGGREGATOR_POLICY;
const BODY_STR   = get("--body");
const FILE_PATH  = get("--file");
const COUNT      = parseInt(get("--count") || "1", 10);
const DELAY_MS   = parseInt(get("--delay") || "0", 10);
const KEY_OVERRIDE = get("--key");

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : undefined;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── List policies ─────────────────────────────────────────────────────────────
async function listPolicies() {
  const res = await request("GET", `${BASE_URL}/api/v1/policies`);
  if (res.status !== 200) {
    console.error("Failed to fetch policies:", res.body);
    process.exit(1);
  }
  const active = res.body.filter(p => p.isActive);
  if (!active.length) { console.log("No active policies found."); return; }
  console.log(`\nActive policies (${active.length}):\n`);
  active.forEach(p => {
    console.log(`  ${p.id}`);
    console.log(`    Name:    ${p.name}`);
    console.log(`    Key:     ${p.keyField}`);
    console.log(`    Cradle:  ${p.cradleField} = "${p.cradleValue}"`);
    console.log(`    Grave:   ${p.graveField} = "${p.graveValue}"`);
    if (p.timeoutMs) console.log(`    Timeout: ${p.timeoutMs}ms`);
    console.log();
  });
}

// ── Ingest one event ──────────────────────────────────────────────────────────
async function ingestOne(policyId, body) {
  const res = await request("POST", `${BASE_URL}/api/v1/events/ingest`, { policyId, body });
  return res;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (has("--help") || has("-h")) {
    console.log(`
Aggre/Gator Ingest CLI

Usage:
  node scripts/ingest.js [options]

Options:
  --api <url>       Base URL (default: http://localhost:3001)
  --policy <uuid>   Policy UUID to ingest against
  --body <json>     JSON string for the event body
  --file <path>     JSON file (single event object or array of events)
  --count <n>       Repeat single event N times (default: 1)
  --delay <ms>      Delay between events when --count > 1 (default: 0)
  --key <value>     Shortcut: set aggregationKey override in body (if your policy reads body.key)
  --list-policies   List all active policies and exit

Environment:
  AGGREGATOR_URL      Default base URL
  AGGREGATOR_POLICY   Default policy UUID

Examples:
  # List active policies
  node scripts/ingest.js --list-policies

  # Ingest a single event
  node scripts/ingest.js --policy abc-123 --body '{"eventType":"trade.initiated","tradeRef":"T-001"}'

  # Ingest from a file
  node scripts/ingest.js --policy abc-123 --file ./events/trade.json

  # Load test: 100 events with 50ms delay
  node scripts/ingest.js --policy abc-123 --body '{"eventType":"order.created","orderId":"ORD-{{i}}"}' --count 100 --delay 50
`);
    return;
  }

  if (has("--list-policies")) {
    await listPolicies();
    return;
  }

  if (!POLICY_ID) {
    console.error("Error: --policy <uuid> is required. Use --list-policies to see available policies.");
    process.exit(1);
  }

  // Build events list
  let events = [];
  if (FILE_PATH) {
    const raw = fs.readFileSync(path.resolve(FILE_PATH), "utf8");
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } else if (BODY_STR) {
    events = [JSON.parse(BODY_STR)];
  } else {
    console.error("Error: either --body <json> or --file <path> is required.");
    process.exit(1);
  }

  // If --count > 1 and single event, repeat it
  if (COUNT > 1 && events.length === 1) {
    const template = JSON.stringify(events[0]);
    events = Array.from({ length: COUNT }, (_, i) =>
      JSON.parse(template.replace(/\{\{i\}\}/g, String(i + 1)))
    );
  }

  const total = events.length;
  let ok = 0, fail = 0;
  const t0 = Date.now();

  for (let i = 0; i < events.length; i++) {
    const body = { ...events[i] };
    if (KEY_OVERRIDE) body.key = KEY_OVERRIDE;

    try {
      const res = await ingestOne(POLICY_ID, body);
      if (res.status === 200 || res.status === 201) {
        ok++;
        const r = res.body;
        const icon = r.action === "group_opened" ? "🟢" : r.action === "group_promoted" ? "✅" : "→";
        console.log(`${icon} [${i+1}/${total}] ${r.action.padEnd(18)} key=${r.aggregationKey} group=${r.groupId?.slice(0,8)}…`);
      } else {
        fail++;
        console.error(`❌ [${i+1}/${total}] HTTP ${res.status}:`, res.body?.error ?? res.body);
      }
    } catch (err) {
      fail++;
      console.error(`❌ [${i+1}/${total}] Network error:`, err.message);
    }

    if (DELAY_MS > 0 && i < events.length - 1) await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n✓ Done — ${ok} ok, ${fail} failed, ${elapsed}s elapsed (${(total / elapsed).toFixed(0)} events/s)`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
