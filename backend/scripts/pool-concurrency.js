#!/usr/bin/env node
/* global console, process, require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
// Load-test the real db/pool.ts query helpers under RLS org context.
// Quiet by default: the pool's connect log is DEBUG in development, which
// would otherwise interleave with the results table.
process.env.NODE_ENV = process.env.NODE_ENV || "production";
//
// Run `npm run build` first -this imports dist/, not src/. Set PG*_env and
// PG_POOL_MAX before starting node (config is a singleton read at import).
// See docs/POOL_CONCURRENCY.md for a full worked example.

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { performance } = require("perf_hooks");

if (!fs.existsSync(path.join(__dirname, "../dist/db/pool.js"))) {
  console.error("Run `npm run build` first -this check imports dist/db/pool.js.");
  process.exit(1);
}
const { getPool, query, runWithOrgContext, closePool } = require("../dist/db/pool");

function usage() {
  console.log(`Usage: node scripts/pool-concurrency.js [options]

Options:
  --concurrency 1,5,10,20,40   Concurrent workers per batch (default 1,5,10,20,40)
  --iterations 200             Operations per mode per concurrency level
  --sleep-ms 10                pg_sleep() inside each query, to model app work
  --help                       Show this help

Set PG_POOL_MAX in the environment (default 10). The database must already be
migrated, and PGUSER must be the app's non-superuser role so RLS is active.`);
}

function parseArgs(argv) {
  const out = {
    concurrency: [1, 5, 10, 20, 40],
    iterations: 200,
    sleepMs: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      usage();
      process.exit(0);
    }
    if (!["--concurrency", "--iterations", "--sleep-ms"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--concurrency") {
      out.concurrency = value.split(",").map((v) => Number(v.trim()));
      if (!out.concurrency.length || out.concurrency.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new Error("--concurrency must be a comma-separated list of positive integers");
      }
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
      if (flag === "--iterations") {
        if (n < 1) throw new Error("--iterations must be at least 1");
        out.iterations = n;
      } else {
        out.sleepMs = n;
      }
    }
  }
  return out;
}

const SQL = `SELECT count(*)::int AS visible, (SELECT pg_sleep($1)) AS delay FROM policies`;

async function makeFixture() {
  const slug = `pool-check-${randomUUID().slice(0, 8)}`;
  const orgRows = await runWithOrgContext({ orgId: null, bypass: true }, () =>
    query(
      `INSERT INTO organisations (name, slug, snmp_community)
       VALUES ($1, $2, $3) RETURNING id`,
      [`Pool Check ${slug}`, slug, `pool-check-${randomUUID()}`]
    )
  );
  const orgId = orgRows[0].id;
  await runWithOrgContext({ orgId, bypass: false }, () =>
    query(
      `INSERT INTO policies
         (name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, org_id)
       VALUES ($1, '*', 'probeId', 'eventType', 'probe.start', 'eventType', 'probe.end', $2)`,
      [`POOL CHECK ${slug}`, orgId]
    )
  );
  return { orgId, slug };
}

async function removeFixture(fixture) {
  if (!fixture) return;
  await runWithOrgContext({ orgId: null, bypass: true }, async () => {
    await query(`DELETE FROM policies WHERE name = $1`, [`POOL CHECK ${fixture.slug}`]);
    await query(`DELETE FROM organisations WHERE id = $1`, [fixture.orgId]);
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function runBatch(mode, fixture, concurrency, iterations, sleepSeconds) {
  const latencies = [];
  let failures = 0;
  const workers = Math.min(concurrency, iterations);
  let next = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= iterations) return;
      const t0 = performance.now();
      try {
        if (mode === "pool.query") {
          await getPool().query(SQL, [sleepSeconds]);
        } else {
          await query(SQL, [sleepSeconds]);
        }
      } catch (err) {
        failures++;
        if (failures === 1) console.error(`  first error: ${err.message}`);
      } finally {
        latencies.push(performance.now() - t0);
      }
    }
  }

  if (mode === "pool.query") {
    await Promise.all(Array.from({ length: workers }, worker));
  } else {
    // One context for the whole batch, as orgContextMiddleware would set for
    // one request. query() picks it up via AsyncLocalStorage on every call.
    await runWithOrgContext({ orgId: fixture.orgId, bypass: false }, () =>
      Promise.all(Array.from({ length: workers }, worker))
    );
  }

  latencies.sort((a, b) => a - b);
  const wallMs = performance.now() - started;
  return {
    mode,
    concurrency,
    iterations,
    failures,
    wallMs,
    opsPerSec: wallMs ? (iterations / wallMs) * 1000 : 0,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: percentile(latencies, 1),
  };
}

function printRow(result) {
  const cells = [
    String(result.concurrency).padStart(4),
    result.mode.padEnd(11),
    String(result.iterations).padStart(4),
    String(result.failures).padStart(4),
    result.wallMs.toFixed(0).padStart(8),
    result.opsPerSec.toFixed(1).padStart(8),
    result.p50.toFixed(1).padStart(7),
    result.p95.toFixed(1).padStart(7),
    result.max.toFixed(1).padStart(7),
  ];
  console.log(cells.join("  "));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Pool max: ${process.env.PG_POOL_MAX || "10"}  iterations/mode: ${opts.iterations}  pg_sleep: ${opts.sleepMs}ms`);
  console.log("");
  console.log(" conc  mode         ops  fail  wall(ms)   ops/sec  p50(ms)  p95(ms)  max(ms)");
  console.log(" ----  -----------  ---  ----  --------  --------  -------  -------  -------");

  const fixture = await makeFixture();
  try {
    const sleepSeconds = opts.sleepMs / 1000;
    // Warm the pool so connection setup isn't charged to the first batch.
    await getPool().query(SQL, [sleepSeconds]);
    await runWithOrgContext({ orgId: fixture.orgId, bypass: false }, () => query(SQL, [sleepSeconds]));

    let failures = 0;
    for (const concurrency of opts.concurrency) {
      for (const mode of ["pool.query", "query+RLS"]) {
        const result = await runBatch(mode, fixture, concurrency, opts.iterations, sleepSeconds);
        printRow(result);
        failures += result.failures;
      }
    }
    if (failures) {
      console.error(`\n${failures} operation(s) failed; check connectionTimeoutMillis / PG_POOL_MAX.`);
      process.exitCode = 1;
    }
  } finally {
    await removeFixture(fixture).catch((err) => console.error(`Fixture cleanup failed: ${err.message}`));
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
