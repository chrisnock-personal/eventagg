# Connection-pool concurrency check

`db/pool.ts` establishes org context with `BEGIN` + `set_config(..., true)` +
`COMMIT` on every query made through `query()`/`queryOne()`. That holds a
pooled connection for four round trips instead of one, so the pool can queue
requests earlier than the old one-shot `pool.query()` path did.

`backend/scripts/pool-concurrency.js` measures both paths against the real
`dist/db/pool` helpers and a migrated PostgreSQL database. It creates one
throwaway org + policy under RLS, runs batches of concurrent queries, and
deletes the fixture at the end.

## Running

The script imports compiled code, so build first. `config` is a singleton read
at import time, so set all `PG*` variables **before** starting node.

```bash
# Against the throwaway test DB (scripts/test-db.sh up):
export PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=eventagg \
       PGUSER=eventagg_user PGPASSWORD=eventagg_pass \
       PG_POOL_MAX=10

cd backend
npm run build
npm run migrate
npm run pool-check
```

Useful options:

```bash
npm run pool-check -- --concurrency 1,10,20,40 --iterations 500 --sleep-ms 25
```

`--sleep-ms` puts a `pg_sleep()` inside every query (inside the transaction for
`query+RLS`) to model application work done while holding the connection.
The default is 10 ms. The query always reads `policies`, so RLS policies are
evaluated on every operation.

`PGUSER` must be the non-superuser app role: superusers bypass RLS, which
would make the comparison meaningless.

## Reading the output

`pool.query` is the old no-context path (one round trip, RLS fails closed and
returns zero rows). `query+RLS` is the real request path (BEGIN, set_config,
SELECT, COMMIT). Watch:

- **ops/sec** — throughput drop as concurrency climbs.
- **p95/max** — queueing delay once concurrency exceeds `PG_POOL_MAX`.
- **fail** — non-zero means a client hit `PG_POOL_CONNECTION_TIMEOUT_MS`.

A visible p95 climb above the pool maximum is expected; it is the pool doing
its job. The question this check answers is whether the climb is gentle enough
for the intended traffic, or whether RLS context setup needs to be batched.

## Observed result (PG_POOL_MAX=10, 10 ms sleep, 200 operations per mode)

Measured on 2026-11-24 against the throwaway WSL Postgres 16 container, through
an SSH tunnel, with the app's non-superuser `eventagg_user` role:

```
 conc  mode         ops  fail  wall(ms)   ops/sec  p50(ms)  p95(ms)  max(ms)
 ----  -----------  ---  ----  --------  --------  -------  -------  -------
   1  pool.query    200     0      3340      59.9     16.5     18.7     22.3
   1  query+RLS     200     0      6145      32.5     30.6     34.1     38.2
   5  pool.query    200     0       685     292.1     15.5     19.1     79.9
   5  query+RLS     200     0      1133     176.5     27.5     32.6     38.5
  10  pool.query    200     0       339     590.4     14.5     19.9     80.6
  10  query+RLS     200     0       637     314.1     30.2     37.6     43.2
  20  pool.query    200     0       303     659.1     28.7     33.1     36.7
  20  query+RLS     200     0       622     321.5     60.0     71.8     78.3
  40  pool.query    200     0       302     661.9     57.4     62.4     66.1
  40  query+RLS     200     0       590     339.0    113.2    127.1    136.1
```

**Read-out**

- The RLS request path costs roughly **2× the latency** (30 ms vs 15 ms p50)
  and caps out near **320 ops/sec** versus ~660 for `pool.query`, because it
  holds a connection for four round trips instead of one.
- Throughput flattens at 10–20 workers for both modes: that is `PG_POOL_MAX`
  doing its job. No operation hit `PG_POOL_CONNECTION_TIMEOUT_MS`.
- Past the pool maximum, p95 grows roughly linearly with concurrency
  (72 ms at 20, 127 ms at 40 for `query+RLS`). This is queueing, not a leak.

**Conclusion for extending RLS to the other tables:** the current pool size is
adequate for ordinary dashboard traffic, but the ingest path should not issue
many separate `query()` calls per event once those tables are RLS-protected.
Batch the writes into a single `withTransaction()` call per request so the
`BEGIN`/`set_config`/`COMMIT` overhead is paid once, not once per statement.
If a workload needs more than ~300 ops/sec under RLS, raise `PG_POOL_MAX`
modestly and re-run this check rather than assuming the old numbers still hold.
