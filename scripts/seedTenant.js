#!/usr/bin/env node
// ─── Aggre/Gator Multi-Tenant SQL Seeder ──────────────────────────────────────
// Generates backdated event groups for ONE organisation, spread across the
// past N days. Uses the global EXAMPLE policies (shared across every org
// since multi-tenancy phase 2) resolved by name via subquery, so it never
// needs to know a policy's UUID up front. SQL goes to stdout; pipe into psql.
//
// Usage:
//   node scripts/seedTenant.js --org-slug tenanta --days 7 --groups 500 | \
//     podman exec -i eventagg psql -U eventagg_user eventagg
//
// Options:
//   --org-slug  Organisation slug to stamp onto every row (required)
//   --days      How many days back to spread groups (default: 7)
//   --groups    Total event groups to generate (default: 500)
//   --open-pct  % of groups left in-progress, not completed (default: 10)

const args = process.argv.slice(2);
const get  = (f, def) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : def; };

const ORG_SLUG = get("--org-slug", null);
const N_DAYS   = parseInt(get("--days", "7"));
const N_GROUPS = parseInt(get("--groups", "500"));
const OPEN_PCT = parseFloat(get("--open-pct", "10")) / 100;

if (!ORG_SLUG) {
  process.stderr.write("Error: --org-slug is required\n");
  process.exit(1);
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)      { return arr[Math.floor(Math.random() * arr.length)]; }
function uid()          { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

function genUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function randomDurationMs() {
  const r = Math.random();
  if (r < 0.30) return rand(5000,    120000);
  if (r < 0.55) return rand(120000,  600000);
  if (r < 0.75) return rand(600000,  3600000);
  if (r < 0.90) return rand(3600000, 28800000);
  return rand(28800000, 172800000);
}

// Same template set as scripts/seedviasql.js -these are the global
// EXAMPLE policies seeded by migrations 006/014.
const POLICY_TEMPLATES = [
  {
    name: "EXAMPLE - Trade Lifecycle",
    keyField: "tradeRef",
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
    generateCradle: () => ({
      eventType: "user.login", sessionId: `sess-${uid()}`, userId: `usr-${uid()}`,
      ipAddress: `10.${rand(0,255)}.${rand(0,255)}.${rand(1,254)}`,
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

const s = (v) => `'${String(v).replace(/'/g, "''")}'`;
const j = (o) => `$re$${JSON.stringify(o)}$re$::jsonb`;
// Subquery resolving a global policy's id by name at apply-time -never
// needs to know the UUID up front, works against any target database.
const policySubquery = (name) => `(SELECT id FROM policies WHERE name = ${s(name)} AND org_id IS NULL)`;
const orgSubquery = `(SELECT id FROM organisations WHERE slug = ${s(ORG_SLUG)})`;

function main() {
  process.stderr.write(`\n🐊  Aggre/Gator Tenant Seeder\n`);
  process.stderr.write(`    Org slug: ${ORG_SLUG}\n`);
  process.stderr.write(`    Groups:   ${N_GROUPS} spread over past ${N_DAYS} days\n`);
  process.stderr.write(`    Open:     ~${Math.round(OPEN_PCT * 100)}% left in-progress\n\n`);

  const nowMs = Date.now();

  // Pre-create any completed_events partitions the date range might need —
  // matches the same logic index.ts's runPartitionJob already relies on.
  const rangeStart = new Date(nowMs - N_DAYS * 86400000);
  const quarters = [];
  const d = new Date(rangeStart);
  d.setDate(1);
  d.setMonth(Math.floor(d.getMonth() / 3) * 3);
  while (d.getTime() <= nowMs) {
    const year = d.getFullYear();
    const q = Math.floor(d.getMonth() / 3);
    const startM = q * 3 + 1;
    const endM = startM + 3;
    const endYear = endM > 12 ? year + 1 : year;
    const endMonthClamped = endM > 12 ? 1 : endM;
    quarters.push({
      name: `completed_events_${year}_q${q + 1}`,
      from: `${year}-${String(startM).padStart(2, "0")}-01`,
      to:   `${endYear}-${String(endMonthClamped).padStart(2, "0")}-01`,
    });
    d.setMonth(d.getMonth() + 3);
  }
  for (const qp of quarters) {
    process.stdout.write(
      `CREATE TABLE IF NOT EXISTS ${qp.name} PARTITION OF completed_events FOR VALUES FROM ('${qp.from}') TO ('${qp.to}');\n`
    );
  }
  process.stdout.write("\n");

  let created = 0, skipped = 0;

  for (let g = 0; g < N_GROUPS; g++) {
    const template = pick(POLICY_TEMPLATES);
    const isOpen = Math.random() < OPEN_PCT;

    const startedAt = new Date(nowMs - Math.random() * N_DAYS * 86400000);
    const durationMs = randomDurationMs();
    const endedAt = new Date(startedAt.getTime() + durationMs);

    if (!isOpen && endedAt.getTime() > nowMs) { skipped++; continue; }

    const cradleBody = template.generateCradle();
    const key = String(cradleBody[template.keyField]);
    const nMiddle = rand(1, 3);
    const middles = template.generateMiddle(key).slice(0, nMiddle);

    const groupId = genUuid();
    const cradleId = genUuid();
    const policyRef = policySubquery(template.name);

    if (isOpen) {
      // ── In-progress group: cradle + a few middles, no grave ────────────
      const rawEvents = [{ id: cradleId, seq: 1, isCradle: true, isGrave: false, body: cradleBody, ts: startedAt }];
      middles.forEach((mb, i) => {
        const ts = new Date(startedAt.getTime() + (Date.now() - startedAt.getTime()) * (i + 1) / (middles.length + 1));
        rawEvents.push({ id: genUuid(), seq: i + 2, isCradle: false, isGrave: false, body: mb, ts });
      });
      const lastSeen = rawEvents[rawEvents.length - 1].ts;

      process.stdout.write("BEGIN;\n");
      process.stdout.write(
        `INSERT INTO in_progress_events (id, org_id, policy_id, aggregation_key, key_field, raw_event_count, cradle_raw_event_id, started_at, last_seen_at, last_raw_event_at) VALUES (` +
        `${s(groupId)}, ${orgSubquery}, ${policyRef}, ${s(key)}, ${s(template.keyField)}, ${rawEvents.length}, ` +
        `${s(cradleId)}, ${s(startedAt.toISOString())}, ${s(lastSeen.toISOString())}, ${s(lastSeen.toISOString())});\n`
      );
      for (const re of rawEvents) {
        process.stdout.write(
          `INSERT INTO raw_events (id, org_id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at) VALUES (` +
          `${s(re.id)}, ${orgSubquery}, ${s(groupId)}, ${policyRef}, ${s(key)}, ${re.seq}, ${re.isCradle}, ${re.isGrave}, ${j(re.body)}, ${s(re.ts.toISOString())});\n`
        );
      }
      process.stdout.write("COMMIT;\n\n");
    } else {
      // ── Completed group: cradle + middles + grave ──────────────────────
      const graveBody = template.generateGrave(key);
      const graveId = genUuid();
      const rawEvents = [{ id: cradleId, seq: 1, isCradle: true, isGrave: false, body: cradleBody, ts: startedAt }];
      const totalSlots = middles.length + 1;
      middles.forEach((mb, i) => {
        const ts = new Date(startedAt.getTime() + durationMs * (i + 1) / totalSlots);
        rawEvents.push({ id: genUuid(), seq: i + 2, isCradle: false, isGrave: false, body: mb, ts });
      });
      rawEvents.push({ id: graveId, seq: rawEvents.length + 1, isCradle: false, isGrave: true, body: graveBody, ts: endedAt });

      process.stdout.write("BEGIN;\n");
      process.stdout.write(
        `INSERT INTO completed_events (id, org_id, policy_id, aggregation_key, key_field, raw_event_count, cradle_raw_event_id, grave_raw_event_id, started_at, ended_at, completed_at, status) VALUES (` +
        `${s(groupId)}, ${orgSubquery}, ${policyRef}, ${s(key)}, ${s(template.keyField)}, ${rawEvents.length}, ` +
        `${s(cradleId)}, ${s(graveId)}, ${s(startedAt.toISOString())}, ${s(endedAt.toISOString())}, ${s(endedAt.toISOString())}, 'completed');\n`
      );
      for (const re of rawEvents) {
        process.stdout.write(
          `INSERT INTO raw_events (id, org_id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at) VALUES (` +
          `${s(re.id)}, ${orgSubquery}, ${s(groupId)}, ${policyRef}, ${s(key)}, ${re.seq}, ${re.isCradle}, ${re.isGrave}, ${j(re.body)}, ${s(re.ts.toISOString())});\n`
        );
      }
      process.stdout.write("COMMIT;\n\n");
    }

    created++;
    if (created % 50 === 0 || created === N_GROUPS) {
      process.stderr.write(`\r  ${created}/${N_GROUPS} groups generated…`);
    }
  }
  process.stderr.write(`\r  ✅  ${created} groups generated (${skipped} skipped)\n\n`);
}

main();
