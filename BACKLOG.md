# Backlog

Open work, roughly in priority order. Finished items and the reasoning behind
them are in [docs/DECISIONS.md](./docs/DECISIONS.md); short gotchas are in
CLAUDE.md.

## Bugs (found 2026-11-03, making the project overview)

Found running a two-org demo (multi-tenancy on, HTTP + SNMP traffic) on
the committed code plus the current working tree.

1. **Routes without org context return nothing under RLS.** `routes/events.ts`
   and `routes/snmp.ts` didn't mount `orgContextMiddleware`, so every query
   joining `policies` saw no rows: the event list and stats were empty for
   every user, and `POST`/`PUT /snmp/rules` always 404ed "Policy not found".
   Fixed in the working tree (one `router.use(orgContextMiddleware)` each);
   still needs a route-level regression test (the existing tests insert
   rules by SQL, which is why this was missed). Check the other routers
   (`webhooks.ts`, `system.ts`) for the same gap.
2. ~~**Restore destroys the database.**~~ *Fixed 2026-11-09 (security-hardening).* Restoring a fresh backup of a
   database with `completed_events` partitions failed at
   `cannot drop inherited constraint "completed_events_2028_q2_pkey"`,
   after psql had already dropped the RLS policies, indexes and
   constraints. With FORCE RLS and no policies left, no rows are visible
   to anyone (bypass included), so nobody can log in. Causes: `pg_dump
   --clean` against partitioned tables, and psql not run with
   `--single-transaction`. At minimum restore in one transaction; better,
   drop and recreate the schema before restoring a dump without `--clean`.
   `backupRestore.test.ts` should restore a database that has partitions.
3. **Timeout emails go to every organisation's admins.**
   `sendGroupTimedOutAlert()` runs inside the sweep's RLS bypass, so
   `SELECT email FROM users WHERE role = 'admin'` returns all orgs' admins
   (a Demo Markets timeout went to the Demo Telecom admin). Filter by the
   group's `org_id`.
4. **Timeout emails say "Timeout: 0 minutes".** `index.ts`'s sweep passes
   `timeoutMs: 0` to `sendGroupTimedOutAlert()`; pass the policy's value.
5. ~~**SMTP config is global but org admins can edit it.**~~ *Fixed 2026-11-09 (security-hardening).* `system_config`
   key `smtp` is one row for the platform, and any org admin can
   overwrite it from Settings. Make it per-org or superadmin-only.
6. **Nested body search matches every group.** `fix.symbol=VOD.L` uses
   `jsonb_path_exists(body, '$.fix.symbol == "VOD.L"')`, which is true
   whenever the predicate returns a value, even `false`. Use
   `jsonb_path_match`, or a filter `$ ? (@.fix.symbol == "VOD.L")`. The
   value is also interpolated into the jsonpath string unescaped.
7. **Quoted phrase body search returns nothing** (`"Northgate Cafe"`),
   although the search box's placeholder suggests quoting.
8. ~~**Admin password in the log.**~~ *Fixed 2026-11-09 (security-hardening).* `seedDefaultAdmin()` logs
   `{ username, password }` on every boot, and admins can read the backend
   log from System Health. Don't log the password.
9. **Date range says "Last 24h" but shows all time on first load.**
   `dateRange` starts as `"24h"` while `fromFilter`/`toFilter` start empty,
   so the stats and charts cover everything under a "last 24 hours" label.
10. **Hourly heatmap built from daily buckets.** For 7d/30d ranges the
    throughput buckets are daily, so the heatmap only lights the 00:00
    (and 01:00 in BST) columns. Query hour-of-day directly.
11. **Unrounded averages in Policy Stats** (`285.601888276947ms`).
12. **Timeline labels overlap** when several raw events are close together
    relative to the group's duration (e.g. invite/trying/ringing of a call).
13. **Policy validator default body for nested keys** puts a literal
    `"fix.clOrdId"` key instead of `{ fix: { clOrdId } }`.
14. **OpenAPI spec is missing routes**: auth, SNMP and organisations are
    not in `openapi.ts`.
15. **Health "Timed out (24h)" showed 0** while groups had timed out in the
    last hour; check the query.
16. ~~**Client IP is the proxy's, so rate limits are shared.**~~ *Fixed 2026-11-09 (security-hardening).* The audit log
    records every source IP as `127.0.0.1` (through nginx) or the
    container's own address (direct to :3001); `trust proxy` isn't set and
    nginx's `X-Forwarded-For` isn't used. The login and ingest rate
    limiters key on `req.ip`, so all clients share one bucket: a burst of
    failed logins from anyone can lock everyone out.
17. **Audit log misses config changes.** Logins, policy changes and ingests
    are recorded, but `webhooks.ts`, `snmp.ts`, `orgs.ts` and `system.ts`
    have no `audit()` calls, and `auth.ts` audits only login/logout, not
    user create/update/delete. Wire `audit()` into those routes.
18. **Ingest floods the audit log.** Each ingested event writes 2-3 rows
    (`event.ingested`, `raw_event.appended`/`group.opened`/`group.promoted`):
    about 2,300 rows in the first few minutes of the demo. That's ingest-path
    cost and buries the human actions. Consider not auditing ingest, or a
    separate table or sampling.
19. **SNMP sources and rules can't be created in the UI.** The panel lists
    them and says "Add rules via POST /api/v1/snmp/rules". Add forms.
20. **Backup panel shows "Audit entries 0" for the superadmin**, although
    the audit log has thousands of rows: the count runs without org
    context/bypass.
21. **Live highlighting is noisy at volume.** With auto-refresh on a
    busy org, nearly every row is highlighted on each refresh, so the
    highlight stops meaning anything. Consider highlighting only state
    changes, or capping it.

## Security review follow-up (parked 2026-11-09)

From `~/local-repos/articles/security-review-2026-11-09.md`. Items 1-9 of
the Aggre/Gator list are implemented and unit-tested (80 backend tests);
what's left:

1. **Container smoke test not run** for the HTTPS/TLS/age changes. Before
   deploying, build the image and check: entrypoint renders nginx and
   generates the self-signed cert; `tls-watcher` is RUNNING; HTTP 308s to
   HTTPS and `/health` stays on HTTP; Settings -> TLS upload is served
   within seconds; a bad staged pair (mismatched key written straight into
   `/app/certs/staged` + `ready`) rolls back with `status.json` ok=false;
   reset goes back to self-signed; `age` is in the image and
   `BACKUP_AGE_RECIPIENTS` gives a `.sql.age`; webhook secrets show
   `enc:v1:` in Postgres. Also a browser pass over Settings (TLS, SMTP
   password placeholder), Webhooks (write-only secret, remove checkbox),
   the Backup panel's encryption banner, and the menu for admin before/after
   multi-tenancy.
2. **Deploy target is the PC's WSL** (192.168.1.195, ssh -p 2222); .135 is
   gone. 8080/8443 are taken there: set `HTTP_PORT`/`HTTPS_PORT` in `.env`.
   `sync.sh` needs the SSH port (2222) passed through.
3. **SNMPv3** (USM authPriv: HMAC-SHA + AES) in the hand-written BER
   receiver. v2c communities are now fail-closed and random, but still sent
   in clear.
4. **Hash ingest API keys** (`organisations.ingest_api_key` is plaintext and
   looked up by value): store SHA-256, show the key once on create/regenerate.
5. **Postgres data at rest** (the `pgdata` volume) isn't encrypted; host disk
   encryption is the practical fix.
6. **Postgres TLS** if the database ever leaves the container (`PGSSL` uses
   `rejectUnauthorized: false`).
7. **gitleaks** over the full history and in CI.

## Next

1. **Prometheus metrics.** `GET /metrics` via `prom-client`: default process
   metrics plus one `http_request_duration_seconds` histogram (method, route,
   status). Copy CallOwl's `backend/src/metrics.ts`. Add ingest counters per
   policy, and the number of in-progress groups.
2. **OpenAPI at build time.** Write `dist/openapi.json` during `npm run build`
   (Alfoir's `generateOpenapi.ts`) instead of building it at runtime, and
   check in CI that the spec builds.
3. **Feed Alfoir/CallRaven/CallNest events into Aggre/Gator.** Their signed
   webhooks become ingest events, with one policy per lifecycle (call, test
   run) so a run that never finishes times out and alerts. Also gives real
   traffic for item 5.
4. **Split up App.tsx** (~4700 lines). By panel into `components/`, sharing
   `api.ts`, types and small helpers. Moving code, not a rewrite. Needs a
   browser walk-through of every panel before and after.
5. **Extend RLS** to `in_progress_events`, `completed_events`, `raw_events`,
   `webhooks`, `webhook_deliveries` and the SNMP tables. First run the
   connection-pool concurrency check (item 7): RLS made each query about 5×
   slower on `policies`, and these tables are on the ingest path.
6. **Vite 5 to 8.** Clears the dev-server advisory that frontend CI currently
   skips with `--omit=dev`. Needs a browser check.
7. **Pool concurrency check.** RLS's per-query `BEGIN/set_config/COMMIT` holds
   a pooled connection longer. Load-test against `PG_POOL_MAX=10`.

## Later

8. **TOTP two-factor login.** CallOwl's `services/mfaService.ts` (otplib).
9. **OIDC single sign-on.** Alfoir's `services/ssoService.ts`.
10. **Interop CI.** Like CallNest's `ci/`: send real traps and HTTP events
    from a neighbouring system in CI, not just from this repo's tests.
11. Batch `triggerWebhooks()`'s delivery rows into one multi-row `INSERT`.
12. The 4 remaining `react-hooks/exhaustive-deps` warnings. Each needs a
    browser check; adding a dependency can cause a render loop.
13. Route CRUD duplication across `policies.ts`/`snmp.ts`/`orgs.ts`/`auth.ts`.
    Only worth it if route code roughly doubles.
14. `minimatch` moderate advisory (no fix released yet). Recheck `npm audit`.
