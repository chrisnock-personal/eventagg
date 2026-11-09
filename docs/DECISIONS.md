# Aggre/Gator: design decisions and history

Detailed write-ups of finished work, moved out of CLAUDE.md on 2026-11-01 so
sessions don't load ~450 lines of history every time. The *why* behind each
choice lives here; CLAUDE.md keeps the short list of gotchas, and
[BACKLOG.md](../BACKLOG.md) the open items. Item numbers below are as they
were in CLAUDE.md, so older commit messages that cite them still make sense.

---
## Pending features

1. ~~**Multi-tenancy — Phase 3**~~ — done. Each org now has its own unique,
   admin-editable `snmp_community` string (migration 025), managed via the
   Organizations panel next to the existing ingest key. `normalizeTrap()`
   (`snmp/trapNormalizer.ts`) resolves org from the trap's community string
   FIRST, before any policy/routing-rule lookup — a trap from a brand-new
   source with no rule configured yet is now attributed to the right
   tenant (visible in their own SNMP log) instead of silently falling into
   the Default Organisation. When resolved, routing-rule matching is
   scoped to that org only via `getRoutingRules(orgId)`; when the
   community string isn't registered to any org, falls back to the old
   unscoped global search for backward compatibility. AggreGator-MIB traps
   whose policy's org disagrees with the community-resolved org are
   dropped as unrouted (logged as a misconfiguration) rather than trusting
   the policy's org silently. Default Organisation's community backfilled
   to `'public'` so existing single-tenant deployments keep working
   unchanged. Tradeoff accepted: community strings must be unique per org —
   two tenants can no longer both use `"public"` on their devices.
   Found and fixed two real bugs while building this: (1) a **latent
   cross-tenant misrouting bug** — `getRoutingRules()` previously fetched
   every org's active rules with no `org_id` filter at all, so a broad
   rule in one org could match a trap meant for another org's narrower
   rule; fixed as a side effect of the org-scoped query above. (2) a
   **live regression from this session's earlier RLS work** — migration
   023 put `policies` under `FORCE ROW LEVEL SECURITY`, but
   `snmp/trapReceiver.ts`'s `processTrap()` (the dgram UDP receiver's only
   entry point) was never wrapped in an org context, unlike every other
   background job — every AggreGator-MIB trap had silently been failing
   "policy not found" since that migration shipped. Fixed by wrapping
   `processTrap()` in `runWithOrgContext({orgId: null, bypass: true}, ...)`,
   matching `runTimeoutJob`/`runPartitionJob`'s existing pattern (org is
   resolved dynamically per-trap inside `normalizeTrap()`, not known
   ahead of time — same reasoning as `POST /auth/login`'s bypass wrap).

2. **Split up App.tsx** — ~4300+ lines, the entire frontend in one file
   (login, burger menu, event groups, reports, every admin panel). Not
   fixing anything broken today (typechecks/lints/builds fine as-is) —
   this is a maintainability call, not a bug. Discussed and deliberately
   deferred: the main risk is that this environment has no browser to
   visually verify the UI after a mechanical refactor of a file this size
   with lots of shared local state and closures — a real regression risk
   that needs the user actually eyeballing the app afterward, not just
   typecheck/build passing. Recommended approach when picked up: split by
   panel/screen (each admin panel, each report view, etc.) into files
   under a `components/` directory, sharing the API client (`api.ts`),
   types, and small helpers (the `C` color palette, `PctBar`, etc.) from
   common modules — moving code, not a rewrite.

## Roadmap to RC

Prototype → release-candidate gaps identified during a review session:

1. ~~**Automated tests + CI**~~ — done. Vitest suite (backend/src/test/ +
   colocated *.test.ts) and GitHub Actions (.github/workflows/ci.yml) cover
   the ingest engine, multi-tenancy isolation, auth, and tenancy/orgs flows.
2. ~~**Fix `runPartitionJob`**~~ — done. Partition bounds in
   `FOR VALUES FROM/TO` don't support bind parameters over the extended query
   protocol; fixed by inlining the (numerically-constructed, non-user-input)
   date literals directly into the SQL.
3. ~~**Close the admin.ts backup/restore/db-stats/vacuum gap**~~ — done.
   `/backup/info`, `/backup`, `/restore`, `/db/stats`, `/db/vacuum` are now
   `superadmin`-only. `/db/purge` stays `admin`-accessible (already org-scoped
   since Phase 1). Also fixed a related inconsistency found while doing this:
   `/db/stats`'s `purgeable_90d` counted every org's rows, not just the
   caller's — split into a new org-scoped `GET /admin/db/purgeable` for the
   admin-facing Data Retention panel; `/db/stats` itself dropped that field
   entirely (whole-instance table stats only, superadmin's DB Maintenance
   panel). Frontend: `DbMaintenancePanel` (stats+VACUUM) moved to superadmin's
   nav; a new `DataRetentionPanel` (purge only) replaced it in the regular
   admin's Administration section; `BackupPanel` moved to superadmin's nav.
4. ~~**Secrets/config hardening**~~ — done. `JWT_SECRET`'s hardcoded fallback
   (a publicly-visible string in source — anyone could've forged a valid
   session, including superadmin, on any deployment that didn't override it)
   is gone; if unset, `middleware/session.ts` now generates a random secret
   per boot instead, with a loud startup warning (sessions invalidate on
   every restart unless set explicitly — matches the `organisations.ingest_api_key`
   auto-generate convention rather than refusing to boot like `PGPASSWORD`).
   New `COOKIE_SECURE` env var (default `false`, matching today's plain-HTTP
   deployments) actually wires up the session cookie's `secure` flag, which
   was previously commented out and unreachable. README documents both plus
   a brief TLS/reverse-proxy note. Found and fixed a real bug while wiring
   this up: `docker-compose.yml` passes `JWT_SECRET` through as `""` (not
   unset) when the host doesn't set it, and `??` doesn't treat `""` as
   absent — silently produced an empty secret and broke every login
   (`jsonwebtoken` rejects `""` outright). Fixed with `||` in session.ts and
   a `.transform()` in config.ts normalizing `""` to `undefined` at the
   source, so no future consumer of `config.jwtSecret` hits the same trap.
5. ~~**Migration rollback story**~~ — done, documentation/process only, no
   code changed. Decision: given a working `pg_dump`-based backup/restore
   (hardened in item 3/4's session — `--clean --if-exists`, `-v ON_ERROR_STOP=1`),
   writing per-migration down-scripts for all 23 migrations wasn't worth it —
   several (partition renames, backfills, data promotions) have no clean
   mechanical inverse anyway, and untested down-scripts are their own risk.
   Documented in `OPERATIONS.md` § "Migrations & Rollback": take a backup
   immediately before any deploy that adds a migration, restore it if the
   deploy goes wrong (restore gives back schema + data together, strictly
   stronger than a schema-only `down` would). `sync.sh` now prints a
   non-blocking reminder before every rebuild step pointing at this. Also
   established a lightweight convention for *future* migrations only: a
   one-line `-- Reversibility: ...` note in the header comment, so the next
   person knows before reaching for the backup whether a schema-level
   rollback is even possible. Existing migrations 001–023 were not
   retrofitted with this.
6. **Database-layer tenant isolation (Postgres RLS)** — prototyped on
   `policies` (migration 023), now extended to `users` and `audit_log`
   (migration 024, same session). `db/pool.ts`'s `AsyncLocalStorage`-based
   org context and `orgContextMiddleware` needed no changes — this was
   "one migration + policy per table + mount the existing middleware in
   the places it was missing." `FORCE ROW LEVEL SECURITY` + a policy keyed
   off `current_setting('app.current_org_id')`/`app.bypass_rls`,
   fail-closed if no context is set. Verified as a genuine backstop:
   `backend/src/test/rls.test.ts` proves a raw unscoped query against each
   of the three tables only returns the caller's own org's rows (+ global
   rows for `policies` specifically).
   Key difference from `policies`: `org_id IS NULL` means "global, visible
   to everyone" on `policies`, but means "superadmin" / "a superadmin's own
   action" on `users`/`audit_log` — so those two tables' policies omit the
   `OR org_id IS NULL` branch entirely; only `bypass_rls` sees those rows.
   Found and fixed three real context-establishment gaps while wiring this
   up, all in places that had no org context at all before: (1) `POST
   /auth/login` — authenticating by username is a cross-org lookup with no
   org known yet, so it now runs under an explicit bypass context, same
   fix applied to `seedDefaultAdmin()` at boot; (2) `POST
   /system/tenancy/enable` (self-promotion to superadmin) — both the
   password re-check and the `org_id -> NULL` write need bypass, the
   latter because `WITH CHECK` only allows a NULL org_id under bypass;
   (3) `routes/audit.ts`, `routes/orgs.ts`, and the rest of `routes/auth.ts`
   (`/change-password`, `/logout`, `/users` CRUD) simply didn't have
   `orgContextMiddleware` mounted yet. Also fixed `test/helpers.ts`'s
   `createTestUser()` (test fixture setup, not a real tenant action — now
   wrapped in bypass) since every existing test that calls it would
   otherwise fail once `users` gained `FORCE ROW LEVEL SECURITY`.
   Measured cost on `policies`: ~5x slower per plain `query()` call against
   an RLS-protected table (0.55ms → 2.69ms/call in a rough local check) —
   the extra BEGIN/SET_CONFIG/COMMIT round-trip plain `query()` now does
   when an org context is active. Still fast in absolute terms.
   Not yet extended: `in_progress_events`, `completed_events`, `raw_events`,
   `webhooks`, `webhook_deliveries`, SNMP tables — higher-traffic, same
   pattern, separate future decision once this second round's cost is
   assessed against real traffic.


---

## Hardening / productising backlog

From a codebase survey (performance, efficiency, hardening, productising)
done after the RC roadmap was completed. Not yet started except where noted.

**Security**
1. ~~**No rate limiting on `POST /auth/login`**~~ — done. `loginRateLimit`
   in `routes/auth.ts` (same `express-rate-limit` library as
   `ingestRateLimit`): 20 attempts / 15 min, keyed by IP (not username —
   keying by username would let an attacker spray many different usernames
   unthrottled), `skipSuccessfulRequests: true` so a legitimate user who
   eventually gets their password right doesn't burn the budget getting
   there. Disabled when `config.nodeEnv === "test"` — the test suite's
   ~27 fixture logins across the file share one in-memory store/IP within
   a single process and would otherwise trip the limiter well before any
   test intends to exercise it (this also means the throttling behavior
   itself isn't covered by an automated test — `config` is a frozen
   singleton read once at import time, so there's no clean way to flip
   `nodeEnv` mid-suite; verified manually instead against the rebuilt
   container: 20 failed attempts returned 401, the 21st returned 429, and
   a subsequent *correct* password was also blocked until the window
   passed — restarting the backend process clears the in-memory store).
2. ~~**`nodemailer` has a high-severity `npm audit` finding**~~ — done.
   Bumped `^6.9.14` → `^9.0.3` (`npm audit`: 0 vulnerabilities). Checked
   nodemailer's actual changelog for every major version crossed: 7.0.0
   only touched AWS SES transport (not used here — this app uses plain
   SMTP host/port/secure/auth); 8.0.0 renamed an error code
   (`'NoAuth'`→`'ENOAUTH'`, not inspected anywhere in this codebase); 9.0.0
   enforces TLS cert validation for remote-content fetches (attachment
   URLs, OAuth2, proxy CONNECT — none of which this app's two call sites,
   `smtpService.ts` and `routes/system.ts`'s `/config/smtp/test`, use).
   None of the three affected this app's actual usage (`createTransport`
   with host/port/secure/auth, `.verify()`, text-only `.sendMail()`).
   `@types/nodemailer` bumped `^6.4.15` → `^8.0.1` (nodemailer 9.x doesn't
   bundle its own types, and DefinitelyTyped's package hasn't published a
   9.x-targeted release yet — 8.0.1 is the closest available and
   typechecks clean against the 9.0.3 runtime for this codebase's usage).
   Verified against the rebuilt container: `/config/smtp/test` against an
   unreachable host and a reachable host with nothing listening both still
   fail cleanly (`ENOTFOUND`/`ECONNREFUSED`) exactly as before — proves
   `createTransport`/`.verify()` still work correctly at runtime.
3. ~~**`routes/admin.ts`/`routes/system.ts` have zero zod validation**~~ —
   done. `system.ts`: `smtpConfigSchema` shared between `PUT /config/smtp`
   (via a per-key `CONFIG_SCHEMAS` map — unknown keys still fall through to
   a permissive "must be a plain object" check, so the generic KV store
   stays forward-compatible) and `POST /config/smtp/test` (shape errors go
   through the standard validation-error path; only an actual
   connection/auth failure gets the route's existing friendly inline 400,
   since testing the connection is the whole point of that endpoint);
   `POST /tenancy/enable`'s password field; `GET /logs/:service`'s `lines`
   query param (was a raw `parseInt` fed into an `execSync` shell string —
   not an injection risk since `parseInt` can't produce shell metacharacters,
   but a malformed value produced a broken command instead of a clean 400).
   `admin.ts`: `POST /db/purge`'s `days` field (`z.coerce.number()`,
   preserves the original "Minimum retention is 30 days" message via zod's
   custom message option). `POST /import/policies` validates the bundle's
   outer shape strictly (`version`, `policies` being an array) but still
   validates each policy item individually with `safeParse`, collecting
   failures into the response's existing `errors` array rather than
   rejecting the whole import — preserves that route's original
   partial-success design (a bundle with 9 good policies and 1 malformed
   one still imports the 9).
4. ~~**`CORS_ORIGIN` defaults to `"*"`**~~ — done. Default changed to empty
   (same-origin only — `app.ts` passes `origin: false` to the `cors`
   package when `CORS_ORIGIN` is unset, which skips
   `Access-Control-Allow-Origin` entirely). This app's own `nginx.conf`
   proxies the frontend and API on the same origin (port 8080), and
   `frontend/vite.config.ts`'s dev-server proxy does the same for local
   dev — no documented usage path ever needed cross-origin browser
   requests, so `"*"` was pure footgun with no upside (it's also silently
   rejected by browsers when combined with `credentials: true` anyway, so
   it never actually worked for a credentialed cross-origin caller either).
   Verified against the rebuilt container: a request with a cross-origin
   `Origin` header gets no `Access-Control-Allow-Origin` back; the real
   nginx-proxied path (port 8080, how an actual browser hits this app) is
   unaffected. `docker-compose.yml`/`README.md` updated — set `CORS_ORIGIN`
   explicitly only if a separately-hosted frontend calls this API directly.

**Code quality**
5. ~~**No shared `AuthedRequest` type**~~ — done. Replaced with a global
   Express `Request` augmentation (`backend/src/types/express.d.ts`,
   `req.user?: SessionUser`, `req.org?: RequestOrg`) — all 55 `(req as
   any).user`/`.org` casts across `routes/*.ts` and `middleware/*.ts`
   replaced with `req.user!`/`req.org!` (non-null assertion, since
   `requireAuth`/`requireApiKey` guarantee it's set by the time route
   handlers run — same guarantee the casts relied on implicitly before).
   Also removed now-dead `SessionUser`/`RequestOrg` imports left over in
   `routes/audit.ts`, `webhooks.ts`, `events.ts`, `snmp.ts`, `ingest.ts`,
   `middleware/orgContext.ts`.
6. Route CRUD duplication across `policies.ts`/`snmp.ts`/`orgs.ts`/`auth.ts`
   — real but low-value at ~1500 lines of route code total; revisit only
   if route code roughly doubles.

**Performance** (no bugs found, just worth knowing)
7. RLS's per-query `BEGIN/COMMIT` (this session) holds a pooled connection
   longer per request than the old one-shot `pool.query()` — worth a
   concurrency check against `PG_POOL_MAX=10` before scaling traffic.
8. `webhookService.ts`'s `triggerWebhooks()` inserts delivery rows one at a
   time in a loop instead of a single multi-row `INSERT` — fine at today's
   per-org webhook counts.
9. `statsCache`/`performanceCache` confirmed still correctly org-scoped
   post-RLS (cache keys include `orgId`) — verified, not a bug.

**Productising**
10. ~~**No `LICENSE` or `CHANGELOG` file**~~ — done. MIT (user's choice,
    over Apache-2.0/proprietary). `LICENSE` at repo root, `"license": "MIT"`
    added to both `package.json`s, and to the OpenAPI spec's `info.license`
    (`backend/src/openapi.ts`, verified in the actual `/api/v1/openapi.json`
    response after rebuilding). Also fixed `openapi.ts`'s `info.contact.url`,
    which was a stale placeholder (`github.com/your-org/aggre-gator`) —
    now points at the real repo. `CHANGELOG.md` (Keep a Changelog format):
    one consolidated `[1.0.0]` entry backfilling everything shipped so far
    (matches `package.json`'s existing `1.0.0`), `[Unreleased]` header for
    real dated entries going forward. `README.md` gets a closing License
    section and both files added to its project-structure listing.
11. ~~**`.env.example` is missing real env vars**~~ — done, plus two live
    bugs found and fixed along the way (both only surfaced because
    `ADMIN_PASSWORD` had never actually been exercised in the deployed
    container before this — see below):
    - `docker-compose.yml` never forwarded `ADMIN_PASSWORD` from the host
      env at all (not even the `${VAR:-default}` pattern every other var
      uses) — setting it in `.env` silently had zero effect, every
      deployment got the hardcoded `admin123` fallback regardless. Fixed
      by adding `ADMIN_PASSWORD: "${ADMIN_PASSWORD:-}"`.
    - `PG_POOL_MAX` was hardcoded to `"10"` (not `${PG_POOL_MAX:-10}`) —
      same silent-no-op problem. `PG_POOL_IDLE_TIMEOUT_MS`/
      `PG_POOL_CONNECTION_TIMEOUT_MS` weren't forwarded at all. All three
      now properly overridable.
    - `seedDefaultAdmin()` (`index.ts`) used the org-scoped `updateUser()`
      service function (`WHERE id=$1 AND org_id=$2`) to refresh the
      seeded admin's password on every boot. Once that admin has been
      promoted to superadmin (via `POST /system/tenancy/enable`, which
      sets `org_id` to `NULL`), that `WHERE` clause matches zero rows —
      `updateUser()` returns `null`, throws nothing, and the surrounding
      code never checked the return value, so `seedDefaultAdmin()` printed
      "Admin password refreshed" unconditionally while the password
      silently never changed. Caught by actually testing the
      newly-forwarded `ADMIN_PASSWORD` end-to-end against the rebuilt
      container (a fresh custom password didn't work; the stale old one
      still did) — the same session's earlier multi-tenancy testing had
      already promoted this container's `admin` user to superadmin, which
      is exactly what put it in the broken state. Fixed by updating by
      `id` alone (a direct `query()` call, matching the pattern the
      adjacent `password_changed = FALSE` reset already used) instead of
      going through the org-scoped service function.
    - Also fixed stale docs: `CLAUDE.md`'s own env var table still said
      `INGEST_API_KEY` was a thing (removed since multi-tenancy Phase 1 —
      ingest auth is `organisations.ingest_api_key` per org now, not a
      global env var) and listed `JWT_SECRET`'s default as the old
      hardcoded dev value instead of "random per boot".
    - `.env.example` rewritten: added `CORS_ORIGIN`, `JWT_SECRET`,
      `COOKIE_SECURE`, `ADMIN_PASSWORD`, `SNMP_ENABLED`/`SNMP_PORT`/
      `SNMP_COMMUNITY`, `PG_POOL_*`; removed the dead `HOST_PORT`/
      `API_PORT`/`PG_PORT` section (docker-compose.yml's port mappings
      are entirely commented out — `network_mode: host` is used instead
      for SNMP UDP, so these variables have had zero effect for a while);
      fixed the header's `docker compose up --build` example to
      `podman-compose up -d --build`, matching every other doc in this repo.
12. ~~**No structured logging**~~ — done. `backend/src/logger.ts`: a single
    `pino` instance, all levels to stdout only (deliberately not split
    across stdout/stderr the way supervisord's `stdout_logfile`/
    `stderr_logfile` historically separated `console.log` from
    `console.error`) — one JSON object per line in production, pretty/
    colorized via `pino-pretty` in development (a devDependency only,
    conditionally required so the production image's `npm install
    --omit=dev` build never breaks), silent under the test suite.
    Request-id correlation via `middleware/requestLogging.ts` + an
    `AsyncLocalStorage` (same pattern as `db/pool.ts`'s org context) —
    mounted first in `app.ts`, so every log line during a request carries
    the same `requestId` automatically via `logger.ts`'s `mixin()`, no
    logger instance threaded through call sites. Also emits one
    `"request"` log per response with `method`/`path`/`statusCode`/
    `durationMs`, replacing the old dev-only method+path `console.log`
    (now runs in every environment).
    All ~54 `console.log`/`.error`/`.warn` call sites converted across 13
    files (`index.ts`, both `snmp/` files, `db/pool.ts`, `app.ts`, both
    auth middlewares, and 6 `services`/`routes` files) — deliberately
    **excluding** `db/migrate.ts` (a one-shot CLI script whose
    human-readable progress banner is the right output for that context,
    not a service emitting structured events) and `config/index.ts`'s
    zod-failure printer (runs while constructing `config`, which
    `logger.ts` itself depends on — importing `logger` there would be
    circular, and it's an immediate `process.exit(1)` fatal path anyway).
    Found a real pre-existing bug while doing this: the admin Log
    Viewer's `backend` tab (`routes/system.ts`'s `SERVICE_LOGS`) only ever
    read `backend.log` (stdout) — every `console.error` call's output went
    to the process's actual stderr, captured separately into
    `backend-err.log`, a file that tab never read. **Every error-level log
    this app has ever emitted had been invisible in that panel.** Routing
    all pino levels to one stdout stream fixes this for free (`backend.log`
    is now the complete stream); also added a `backend-err` tab (mirroring
    the existing `nginx`/`nginx (error)` split) so genuine uncaught-crash
    output that bypasses pino entirely is still visible somewhere.
    `routes/system.ts`'s error-detection now parses real JSON `level` for
    the `backend` service instead of a substring match
    (`/error|warn|fatal/i` per line); `nginx`/`nginx-access`/`postgres`
    keep that substring heuristic unchanged since they're external
    processes in their own native formats. `frontend/src/App.tsx`'s
    `SystemHealthPanel` gets a matching `formatLogLine()` — parses each
    line as pino JSON into `HH:MM:SS [LEVEL] message  {fields}`, coloring
    by the real level number, falling back to today's raw-text-plus-regex
    rendering for anything that isn't valid JSON (nginx/postgres).
    Verified end-to-end against the rebuilt container: `X-Request-Id`
    response header matches the `requestId` on that request's log lines;
    triggering a real 500 produced a `level: 50` line with a proper stack
    trace via pino's `err` serializer; the Log Viewer's `errors` array
    correctly picked out both a `warn` and an `error` line via real level
    parsing; postgres's log tab confirmed visually unchanged.
13. ~~**CI gaps**~~ — done. Added ESLint (flat config, `eslint.config.mjs`
    in each package — neither had one before) via `typescript-eslint`'s
    recommended rules; `@typescript-eslint/no-explicit-any` off (this
    codebase uses `any` deliberately in many places), `no-unused-vars` set
    to warn not error (matches frontend's own `tsconfig.json` already
    having `noUnusedLocals`/`noUnusedParameters: false`). Frontend also
    gets `eslint-plugin-react-hooks` — deliberately pinned to **v5**, not
    the current v7: v7's newer `static-components`/`set-state-in-effect`
    rules flagged pervasive, currently-idiomatic patterns across
    `App.tsx` (nested component definitions, fetch-on-mount effects)
    whose fix would be a real structural refactor, well beyond "add a
    lint step" — v5 keeps the classic rules-of-hooks + exhaustive-deps
    checks only. (ESLint itself pinned to 9.x in both packages too, since
    react-hooks v5's peer range tops out at `^9.0.0`.)
    Fixed everything the resulting lint run actually flagged: a genuine
    **rules-of-hooks bug** in two components (`ReportsOverview`,
    `ReportsPolicyStats`) that called `useState` *after* an early
    `if (!stats) return ...` — hooks must run unconditionally every
    render, so if `stats` ever went from populated back to null on a
    later render (e.g. a refetch), the hook call order would change and
    React's state would misbehave; fixed by moving the hook calls above
    the guard. Also: two "ternary used as a statement" `no-unused-
    expressions` errors (converted to `if/else`), an unnecessary escape
    character, six `no-useless-assignment` findings in `eventService.ts`
    (five were a false-positive on the `$${i++}` sequential-SQL-
    placeholder idiom — rule disabled with a comment; one was a genuine
    dead initializer, fixed), and a batch of unused imports/vars/whole
    dead functions across both packages — including a fully stale,
    **buggy duplicate** `backend/src/snmp/snmp-bridge.js` sitting inside
    `backend/src/snmp/` that predated the real varbind-OID-parsing bugfix
    already shipped in the canonical `scripts/snmp-bridge.js` (deleted;
    nothing referenced it, `tsc` never compiled it since it's plain `.js`
    with no `allowJs`). `react-hooks/exhaustive-deps` warnings (4 remain)
    deliberately left as warnings, not fixed — blindly adding a missing
    dependency risks introducing a render loop or changing behavior in
    ways this environment can't visually/runtime-verify.
    `npm run lint` added to both `package.json`s and to CI (after
    typecheck, before build). CI also gained: `npm run build` for the
    backend (previously only typechecked, never confirmed the real `tsc`
    build succeeds); `npm audit --audit-level=high` for the backend
    (everything there ships to production); `npm audit --omit=dev
    --audit-level=high` for the frontend (only `react`/`react-dom` are
    real runtime deps — vite/esbuild/babel are build-time-only for this
    always-statically-built-then-nginx-served frontend, and currently
    carry a known dev-server-only advisory, GHSA-67mh-4wv8-2f99, that
    doesn't reach the shipped output; fixing it needs a Vite 5→8 major
    bump, tracked as its own future decision, not silently ignored); and
    a new `docker-build` job that builds the real `Dockerfile` and smoke-
    tests it (`docker run` with zero extra env vars, relying on the
    image's own baked-in defaults, then polls `/health`) — verified
    locally with the Podman equivalent before trusting the Docker-based
    CI syntax.

---
---

## Session history summary

Sessions 1-3: Core schema, policy engine, ingest service, basic UI, stats/reports.
Session 4: Timeout support, partition management, duplicate detection, performance view.
Session 5: OpenAPI/Swagger, rate limiting, cache layer, load testing.
Session 6: Authentication (JWT cookies), roles, audit log, policy-aware ingest form,
           SNMP trap receiver, AggreGator MIB, send-trap.js, BER parser debugging.
Session 7: Force password change, role enforcement, audit log UI, SNMP parser bug fixes
           (varbindList wrapper + varbind OID scoping + keyField normalizer fix),
           sync.sh, network_mode: host for rootless Podman UDP.
Session 8: Fixed build failures (orphaned function bodies in api.ts + userService.ts from
           partial edits). Completed role enforcement in UI (Policies hidden for viewers,
           Accounts admin-only). Inactive policy warning in IngestModal. IngestModal already
           had Cradle/Middle/Grave buttons, policy rules summary, and live resolution.
           Webhook/notification system (migration 013, webhookService.ts, routes/webhooks.ts,
           WebhooksPanel in burger menu, wired into ingest + timeout sweep).
Session 9: Added webhooks to OpenAPI spec (Webhook, WebhookDelivery, WebhookEventPayload
           schemas + /webhooks, /webhooks/{id}, /webhooks/deliveries paths). Updated
           CLAUDE.md: webhooks marked complete, stale event-export item removed.
Session 10: Admin screens (System Health, Audit Log, Import/Export, Backup, DB Maintenance,
            Settings/SMTP). Migration 015 (system_config table). routes/system.ts,
            routes/admin.ts, services/smtpService.ts. Audit route now returns
            { rows, total, limit, offset } with real COUNT for pagination.
            demo.js interactive demo script (4 scenarios). OpenAPI spec updated with
            Audit, System, Admin tags and paths. nodemailer added to package.json.
