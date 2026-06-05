#!/usr/bin/env node
// ─── Aggre/Gator SQL Seeder ───────────────────────────────────────────────────
// Generates backdated SQL inserts spread across the past N days.
// SQL goes to stdout; pipe it into psql inside the container.
//
// Usage:
//   node scripts/seedviasql.js --days 30 --groups 500 --api http://192.168.1.135:3001 | \
//     ssh chris@192.168.1.135 "podman exec -i eventagg psql -U eventagg_user eventagg"
//
//   # Save to file first if you want to inspect before running:
//   node scripts/seedviasql.js --days 90 --groups 1000 --api http://192.168.1.135:3001 > /tmp/seed.sql
//   ssh chris@192.168.1.135 "podman exec -i eventagg psql -U eventagg_user eventagg" < /tmp/seed.sql
//
// Options:
//   --api       Base URL to fetch active policies from (default: http://localhost:3001)
//   --days      How many days back to spread groups (default: 30)
//   --groups    Total completed groups to generate (default: 200)
//   --segs-min  Min raw events per group (default: 2)
//   --segs-max  Max raw events per group (default: 6)

const https = require("https");
const http  = require("http");

const args = process.argv.slice(2);
const get  = (f, def) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : def; };

const BASE_URL = get("--api",      "http://localhost:3001");
const N_DAYS   = parseInt(get("--days",   "30"));
const N_GROUPS = parseInt(get("--groups", "200"));
const SEGS_MIN = parseInt(get("--segs-min", "2"));
const SEGS_MAX = parseInt(get("--segs-max", "6"));

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)      { return arr[Math.floor(Math.random() * arr.length)]; }
function uid()          { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

function genUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Weighted random duration — skewed toward shorter completions
function randomDurationMs() {
  const r = Math.random();
  if (r < 0.30) return rand(5000,    120000);    // 5s–2min
  if (r < 0.55) return rand(120000,  600000);    // 2–10min
  if (r < 0.75) return rand(600000,  3600000);   // 10min–1h
  if (r < 0.90) return rand(3600000, 28800000);  // 1–8h
  return rand(28800000, 172800000);              // 8h–2d
}

function request(method, url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const POLICY_TEMPLATES = [
  {
    name: "EXAMPLE - Trade Lifecycle",
    keyField: "tradeRef",
    cradleField: "eventType", cradleValue: "trade.initiated",
    graveField:  "status",    graveValue:  "settled",
    generateCradle: () => ({
      eventType: "trade.initiated", tradeRef: `TRD-${uid()}`,
      counterparty: pick(["BANK-A","BANK-B","BANK-C"]),
      notional: rand(10000, 5000000), currency: pick(["GBP","USD","EUR"]),
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
    keyField: "sessionId",
    cradleField: "eventType", cradleValue: "user.login",
    graveField:  "eventType", graveValue:  "user.logout",
    generateCradle: () => ({
      eventType: "user.login", sessionId: `sess-${uid()}`, userId: `usr-${uid()}`,
      ipAddress: `192.168.${rand(0,255)}.${rand(1,254)}`,
      userAgent: pick(["Chrome/120","Firefox/121","Safari/17"]),
    }),
    generateMiddle: (key) => [
      { eventType: "user.action", sessionId: key, action: pick(["view_dashboard","search","export"]) },
      { eventType: "user.action", sessionId: key, action: pick(["view_reports","filter","drill_down"]) },
    ],
    generateGrave: (key) => ({ eventType: "user.logout", sessionId: key, duration: rand(30, 3600) }),
  },
  {
    name: "EXAMPLE - Order Flow",
    keyField: "orderId",
    cradleField: "eventType", cradleValue: "order.created",
    graveField:  "eventType", graveValue:  "order.delivered",
    generateCradle: () => ({
      eventType: "order.created", orderId: `ORD-${uid()}`, customerId: `cust-${uid()}`,
      items: rand(1, 8), total: rand(10, 5000),
    }),
    generateMiddle: (key) => [
      { eventType: "order.payment",    orderId: key, method: pick(["card","paypal","bank"]), status: "approved" },
      { eventType: "order.shipped",    orderId: key, carrier: pick(["Royal Mail","DHL","FedEx"]), trackingRef: `TRK-${uid()}` },
      { eventType: "order.in_transit", orderId: key, location: pick(["London","Manchester","Edinburgh"]) },
    ],
    generateGrave: (key) => ({ eventType: "order.delivered", orderId: key, signature: pick(["left_at_door","signed","neighbour"]) }),
  },
  {
    name: "EXAMPLE - API Request/Response",
    keyField: "correlationId",
    cradleField: "eventType", cradleValue: "api.request",
    graveField:  "eventType", graveValue:  "api.response",
    generateCradle: () => ({
      eventType: "api.request", correlationId: `req-${uid()}`,
      method: pick(["GET","POST","PUT","DELETE"]),
      endpoint: pick(["/api/v1/events","/api/v1/policies","/api/v1/events/ingest"]),
      clientId: `client-${rand(1,20)}`,
    }),
    generateMiddle: () => [],
    generateGrave: (key) => ({
      eventType: "api.response", correlationId: key,
      statusCode: pick([200,200,200,201,400,404,500]), durationMs: rand(5, 2000),
    }),
  },
];

async function main() {
  process.stderr.write(`\n🐊  Aggre/Gator SQL Seeder\n`);
  process.stderr.write(`    API:    ${BASE_URL}\n`);
  process.stderr.write(`    Groups: ${N_GROUPS} spread over past ${N_DAYS} days\n`);
  process.stderr.write(`    Events: ${SEGS_MIN}–${SEGS_MAX} per group\n\n`);

  const polRes = await request("GET", `${BASE_URL}/api/v1/policies`);
  if (polRes.status !== 200) { process.stderr.write("Failed to fetch policies\n"); process.exit(1); }

  const policies = polRes.body.filter(p => p.isActive);
  if (!policies.length) { process.stderr.write("No active policies found.\n"); process.exit(1); }

  const policyMap = new Map();
  for (const pol of policies) {
    const template = POLICY_TEMPLATES.find(t => t.name === pol.name);
    if (template) {
      policyMap.set(pol.id, { pol, template });
    } else {
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
  const nowMs = Date.now();
  let created = 0, skipped = 0;

  // Emit CREATE TABLE IF NOT EXISTS for every quarter covered by the date range.
  // completed_events is partitioned by completed_at — missing partitions cause INSERTs to fail.
  const rangeStart = new Date(nowMs - N_DAYS * 86400000);
  const quarters = [];
  const d = new Date(rangeStart);
  d.setDate(1);
  d.setMonth(Math.floor(d.getMonth() / 3) * 3); // snap to quarter start
  while (d.getTime() <= nowMs) {
    const year = d.getFullYear();
    const q    = Math.floor(d.getMonth() / 3); // 0-based
    const startM = q * 3 + 1;                  // 1-based month
    const endM   = startM + 3;
    const endYear = endM > 12 ? year + 1 : year;
    const endMonthClamped = endM > 12 ? 1 : endM;
    quarters.push({
      name:  `completed_events_${year}_q${q + 1}`,
      from:  `${year}-${String(startM).padStart(2,"0")}-01`,
      to:    `${endYear}-${String(endMonthClamped).padStart(2,"0")}-01`,
    });
    d.setMonth(d.getMonth() + 3);
  }

  for (const qp of quarters) {
    process.stdout.write(
      `CREATE TABLE IF NOT EXISTS ${qp.name} PARTITION OF completed_events FOR VALUES FROM ('${qp.from}') TO ('${qp.to}');\n`
    );
  }
  process.stdout.write("\n");

  // Each group is its own transaction so one failure doesn't abort the rest.
  for (let g = 0; g < N_GROUPS; g++) {
    const policyId = pick(policyIds);
    const { pol, template } = policyMap.get(policyId);

    const startedAt  = new Date(nowMs - Math.random() * N_DAYS * 86400000);
    const durationMs = randomDurationMs();
    const endedAt    = new Date(startedAt.getTime() + durationMs);

    if (endedAt.getTime() > nowMs) { skipped++; continue; }

    const nMiddle    = rand(Math.max(0, SEGS_MIN - 2), Math.max(0, SEGS_MAX - 2));
    const cradleBody = template.generateCradle();
    const key        = String(cradleBody[pol.keyField] ?? `key-${uid()}`);
    const middles    = template.generateMiddle(key).slice(0, nMiddle);
    const graveBody  = template.generateGrave(key);

    const groupId  = genUuid();
    const cradleId = genUuid();
    const graveId  = genUuid();

    const rawEvents = [];
    rawEvents.push({ id: cradleId, seq: 1, isCradle: true,  isGrave: false, body: cradleBody, ts: startedAt });
    const totalSlots = middles.length + 1;
    middles.forEach((mb, i) => {
      const ts = new Date(startedAt.getTime() + durationMs * (i + 1) / totalSlots);
      rawEvents.push({ id: genUuid(), seq: i + 2, isCradle: false, isGrave: false, body: mb, ts });
    });
    rawEvents.push({ id: graveId, seq: rawEvents.length + 1, isCradle: false, isGrave: true, body: graveBody, ts: endedAt });

    const s = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const j = (o) => `$re$${JSON.stringify(o)}$re$::jsonb`;

    process.stdout.write("BEGIN;\n");
    process.stdout.write(
      `INSERT INTO completed_events (id, policy_id, aggregation_key, key_field, raw_event_count, cradle_raw_event_id, grave_raw_event_id, started_at, ended_at, completed_at, status) VALUES (` +
      `${s(groupId)}, ${s(policyId)}, ${s(key)}, ${s(pol.keyField)}, ${rawEvents.length}, ` +
      `${s(cradleId)}, ${s(graveId)}, ${s(startedAt.toISOString())}, ${s(endedAt.toISOString())}, ${s(endedAt.toISOString())}, 'completed');\n`
    );
    for (const re of rawEvents) {
      process.stdout.write(
        `INSERT INTO raw_events (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at) VALUES (` +
        `${s(re.id)}, ${s(groupId)}, ${s(policyId)}, ${s(key)}, ${re.seq}, ${re.isCradle}, ${re.isGrave}, ${j(re.body)}, ${s(re.ts.toISOString())});\n`
      );
    }
    process.stdout.write("COMMIT;\n\n");

    created++;
    if (created % 50 === 0 || created === N_GROUPS) {
      process.stderr.write(`\r  ${created} groups generated…`);
    }
  }
  process.stderr.write(`\r  ✅  ${created} groups generated (${skipped} skipped — duration exceeded now)\n\n`);
}

main().catch(err => { process.stderr.write(err.message + "\n"); process.exit(1); });
