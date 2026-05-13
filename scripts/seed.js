#!/usr/bin/env node
// ─── Aggre/Gator Seeder ───────────────────────────────────────────────────────
// Usage:
//   node scripts/seed.js                        # defaults: 4 policies, 200 groups
//   node scripts/seed.js --groups 1000 --delay 0
//   node scripts/seed.js --policies 2 --groups 500 --segs-min 2 --segs-max 8
//   node scripts/seed.js --load-test --groups 5000
//
// Options:
//   --api         Base URL (default: http://localhost:3001)
//   --groups      Total event groups to create (default: 200)
//   --segs-min    Min segments per group (default: 2)
//   --segs-max    Max segments per group (default: 6)
//   --open-pct    % of groups to leave in-progress (default: 15)
//   --delay       ms delay between requests (default: 10)
//   --load-test   High volume mode: 5000 groups, no delay, progress every 100

const https = require("https");
const http  = require("http");

const args    = process.argv.slice(2);
const get     = (f, def) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : def; };
const has     = (f) => args.includes(f);

const BASE_URL  = get("--api", "http://localhost:3001");
const N_GROUPS  = parseInt(get("--groups", has("--load-test") ? "5000" : "200"));
const SEGS_MIN  = parseInt(get("--segs-min", "2"));
const SEGS_MAX  = parseInt(get("--segs-max", "6"));
const OPEN_PCT  = parseFloat(get("--open-pct", "15")) / 100;
const DELAY_MS  = parseInt(get("--delay", has("--load-test") ? "0" : "10"));
const PROGRESS  = has("--load-test") ? 100 : 25;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function uid() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : undefined;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname,
      method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
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

// ── Policy templates with realistic event schemas ─────────────────────────────
const POLICY_TEMPLATES = [
  {
    name: "EXAMPLE - Trade Lifecycle",
    domain: "trade.*",
    keyField: "tradeRef",
    cradleField: "eventType", cradleValue: "trade.initiated",
    graveField: "status",     graveValue: "settled",
    generateCradle: () => ({
      eventType: "trade.initiated",
      tradeRef:  `TRD-${uid()}`,
      counterparty: pick(["BANK-A","BANK-B","BANK-C"]),
      notional: rand(10000, 5000000),
      currency: pick(["GBP","USD","EUR"]),
      instrument: pick(["BOND","EQUITY","SWAP","FX"]),
    }),
    generateMiddle: (key) => [
      { eventType: "trade.confirmed",  tradeRef: key, confirmationId: `CNF-${uid()}` },
      { eventType: "trade.cleared",    tradeRef: key, clearingRef: `CLR-${uid()}` },
      { eventType: "trade.risk_check", tradeRef: key, riskScore: rand(1, 100) },
    ],
    generateGrave: (key) => ({ eventType: "trade.settled", tradeRef: key, status: "settled", settlementRef: `STL-${uid()}` }),
  },
  {
    name: "EXAMPLE - User Session",
    domain: "user.*",
    keyField: "sessionId",
    cradleField: "eventType", cradleValue: "user.login",
    graveField: "eventType",  graveValue: "user.logout",
    generateCradle: () => ({
      eventType: "user.login",
      sessionId: `sess-${uid()}`,
      userId: `usr-${uid()}`,
      ipAddress: `192.168.${rand(0,255)}.${rand(1,254)}`,
      userAgent: pick(["Chrome/120","Firefox/121","Safari/17"]),
    }),
    generateMiddle: (key) => [
      { eventType: "user.action", sessionId: key, action: pick(["view_dashboard","search","export","create_policy"]) },
      { eventType: "user.action", sessionId: key, action: pick(["view_reports","filter","drill_down"]) },
    ],
    generateGrave: (key) => ({ eventType: "user.logout", sessionId: key, duration: rand(30, 3600) }),
  },
  {
    name: "EXAMPLE - Order Flow",
    domain: "order.*",
    keyField: "orderId",
    cradleField: "eventType", cradleValue: "order.created",
    graveField: "eventType",  graveValue: "order.delivered",
    generateCradle: () => ({
      eventType: "order.created",
      orderId: `ORD-${uid()}`,
      customerId: `cust-${uid()}`,
      items: rand(1, 8),
      total: rand(10, 5000),
    }),
    generateMiddle: (key) => [
      { eventType: "order.payment",  orderId: key, method: pick(["card","paypal","bank"]), status: "approved" },
      { eventType: "order.shipped",  orderId: key, carrier: pick(["Royal Mail","DHL","FedEx"]), trackingRef: `TRK-${uid()}` },
      { eventType: "order.in_transit",orderId: key, location: pick(["London","Manchester","Edinburgh"]) },
    ],
    generateGrave: (key) => ({ eventType: "order.delivered", orderId: key, signature: pick(["left_at_door","signed","neighbour"]) }),
  },
  {
    name: "EXAMPLE - API Request/Response",
    domain: "api.*",
    keyField: "correlationId",
    cradleField: "eventType", cradleValue: "api.request",
    graveField: "eventType",  graveValue: "api.response",
    generateCradle: () => ({
      eventType: "api.request",
      correlationId: `req-${uid()}`,
      method: pick(["GET","POST","PUT","DELETE"]),
      endpoint: pick(["/api/v1/events","/api/v1/policies","/api/v1/events/ingest"]),
      clientId: `client-${rand(1,20)}`,
    }),
    generateMiddle: () => [],
    generateGrave: (key) => ({
      eventType: "api.response",
      correlationId: key,
      statusCode: pick([200,200,200,201,400,404,500]),
      durationMs: rand(5, 2000),
    }),
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🐊  Aggre/Gator Seeder`);
  console.log(`    API:      ${BASE_URL}`);
  console.log(`    Groups:   ${N_GROUPS}`);
  console.log(`    Segments: ${SEGS_MIN}–${SEGS_MAX} per group`);
  console.log(`    Open:     ~${Math.round(OPEN_PCT * 100)}% left in-progress`);
  console.log(`    Delay:    ${DELAY_MS}ms\n`);

  // 1. Fetch existing policies
  const polRes = await request("GET", `${BASE_URL}/api/v1/policies`);
  if (polRes.status !== 200) { console.error("Failed to fetch policies"); process.exit(1); }

  let policies = polRes.body.filter(p => p.isActive);
  if (!policies.length) {
    console.error("No active policies found. Please create policies first via the UI or API.");
    process.exit(1);
  }

  // Map policy names to templates
  const policyMap = new Map();
  for (const pol of policies) {
    const template = POLICY_TEMPLATES.find(t => t.name === pol.name);
    if (template) policyMap.set(pol.id, { pol, template });
  }

  if (!policyMap.size) {
    // Fallback: use whatever policies exist with generic bodies
    for (const pol of policies) {
      policyMap.set(pol.id, {
        pol,
        template: {
          generateCradle: () => ({ [pol.keyField]: `key-${uid()}`, [pol.cradleField]: pol.cradleValue }),
          generateMiddle: (key) => [{ [pol.keyField]: key, eventType: "middle" }],
          generateGrave:  (key) => ({ [pol.keyField]: key, [pol.graveField]: pol.graveValue }),
        },
      });
    }
  }

  const policyIds = [...policyMap.keys()];
  let created = 0, failed = 0, totalSegments = 0;
  const t0 = Date.now();

  for (let g = 0; g < N_GROUPS; g++) {
    const policyId = pick(policyIds);
    const { pol, template } = policyMap.get(policyId);
    const isOpen = Math.random() < OPEN_PCT;
    const nMiddle = rand(Math.max(0, SEGS_MIN - 2), Math.max(0, SEGS_MAX - 2));

    // Cradle
    const cradleBody = template.generateCradle();
    const key = cradleBody[pol.keyField] ?? cradleBody[pol.keyField.replace("body.","")];

    try {
      const r1 = await request("POST", `${BASE_URL}/api/v1/events/ingest`, { policyId, body: cradleBody });
      if (r1.status !== 201 && r1.status !== 200) throw new Error(`HTTP ${r1.status}: ${JSON.stringify(r1.body)}`);
      totalSegments++;

      // Middle segments
      const middles = template.generateMiddle(String(key)).slice(0, nMiddle);
      for (const mb of middles) {
        await request("POST", `${BASE_URL}/api/v1/events/ingest`, { policyId, body: mb });
        totalSegments++;
        if (DELAY_MS > 0) await sleep(DELAY_MS);
      }

      // Grave (only if not leaving open)
      if (!isOpen) {
        const graveBody = template.generateGrave(String(key));
        await request("POST", `${BASE_URL}/api/v1/events/ingest`, { policyId, body: graveBody });
        totalSegments++;
      }

      created++;
      if (created % PROGRESS === 0 || created === N_GROUPS) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = (totalSegments / elapsed).toFixed(0);
        process.stdout.write(`\r  ${created}/${N_GROUPS} groups  ${totalSegments} segments  ${rate} segs/s  ${failed} errors   `);
      }
    } catch (err) {
      failed++;
      if (failed <= 5) console.error(`\n  ❌ Group ${g+1}: ${err.message}`);
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\n✅  Done — ${created} groups, ${totalSegments} segments, ${failed} errors, ${elapsed}s`);
  console.log(`    Throughput: ${(totalSegments / elapsed).toFixed(0)} segments/s`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
