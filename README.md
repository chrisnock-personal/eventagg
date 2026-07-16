# Aggre/Gator

> *event streams, swallowed whole*

Aggre/Gator is an intelligent event stream aggregation platform. It ingests events from any source (HTTP or SNMP traps), groups related events by a configurable key, tracks the complete cradle-to-grave lifecycle of each group, and surfaces real-time insights through a built-in dashboard and REST API.

**Experimental/Prototype**

---

## What it does

Modern systems produce floods of related events that arrive fragmented, out of order, and from many sources. Aggre/Gator solves this by:

- **Accepting events from any producer** — a single HTTP endpoint handles APIs, queues, webhooks and batch jobs; a built-in SNMP trap receiver handles network/telecom sources
- **Grouping events automatically** by a configurable field in the event body (e.g. `tradeRef`, `orderId`, `sessionId`)
- **Tracking lifecycle from first to last event** using user-defined cradle (open) and grave (close) conditions per policy
- **Auto-closing stale groups** via configurable per-policy timeouts with retroactive sweep, and emailing admins when a group times out
- **Surfacing insights** through real-time charts, per-policy health cards, duration histograms, and performance tables
- **Notifying external systems** via HMAC-signed webhooks on group open/complete/timeout, with delivery logging and retry
- **Auditing every mutation** — logins, policy changes, ingests and admin actions are all recorded and viewable/paginated in the UI
- **Full headless access** — every core feature is available via the REST API with no UI required

---

## Quick start

```bash
# Build and run (requires Podman + podman-compose)
podman build --no-cache --layers=false -t localhost/eventagg_eventagg:latest .
podman-compose up -d

# UI (login: admin / admin123 — forced password change on first login)
open http://localhost:8080

# API docs — Swagger UI
open http://localhost:3001/api/v1/docs

# Health check
curl http://localhost:3001/health
```

Runs as a single container — PostgreSQL 16 + Node.js backend + nginx frontend, managed by supervisord. `docker-compose.yml` uses `network_mode: host` (required so the SNMP UDP receiver can see external traffic under rootless Podman), so services bind directly to host ports rather than going through a port mapping.

The base OS image is selectable at build time:

```bash
podman-compose build --build-arg BASE_IMAGE=fedora:40
podman-compose build --build-arg BASE_IMAGE=rockylinux:9
podman-compose build --build-arg BASE_IMAGE=debian:12
# default: ubuntu:22.04
```

---

## Architecture

```
Producers (HTTP or SNMP)
    │
    ▼
POST /api/v1/events/ingest          rate-limited · API-key-gated
UDP :1162 (SNMP traps)              dgram receiver + hand-written BER/ASN.1 parser
    │
    ▼
Policy Engine
  ├── Extracts aggregation key      configurable dot-notation field path
  ├── Evaluates cradle condition    opens a new event group
  ├── Appends raw event             links event to existing group
  └── Evaluates grave condition     promotes group to completed
    │
    ▼
PostgreSQL 16
  ├── in_progress_events            hot store for open groups
  ├── completed_events              quarterly partitions, auto-managed
  ├── raw_events                    GIN-indexed JSONB, duplicate-guarded
  ├── audit_log                     every login / mutation / ingest event
  ├── webhooks + webhook_deliveries HMAC-signed outbound notifications
  └── system_config                 SMTP + misc config (JSONB)
    │
    ▼
REST API + React UI                 headless or browser, JWT session auth
```

**Background jobs** (in-process, `backend/src/index.ts`):

| Job | Interval | Purpose |
|-----|----------|---------|
| Timeout sweep | 60s | Closes groups that exceed their policy timeout, fires webhook + SMTP alert |
| Partition manager | 24h | Pre-creates the next 3 quarters of `completed_events` partitions |

---

## Authentication

The UI requires login. Credentials are stored in the `users` table with bcryptjs-hashed passwords, and sessions are a JWT in an httpOnly cookie (`ag_session`, 8h TTL).

Default account created on first boot: `admin` / `admin123` — the seeded admin is forced to change their password on first login (`ADMIN_PASSWORD` env var can set the initial password instead).

| Role | Permissions |
|------|-------------|
| `viewer` | Read-only access to events and reports |
| `editor` | Ingest events, manage policies, manage webhooks |
| `admin` | Full access, including account management and the Administration panels |

Account management (add, disable, remove users, change roles) and all admin panels live in the **☰ burger menu**, top-right of the UI.

---

## REST API

Full interactive docs at `GET /api/v1/docs` (Swagger UI) · Spec at `GET /api/v1/openapi.json`

### Events

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/events/ingest` | Ingest an event (rate-limited, API-key-gated) |
| `GET` | `/api/v1/events` | List and filter event groups |
| `GET` | `/api/v1/events/:id` | Event group detail |
| `GET` | `/api/v1/events/:id/raw-events` | Raw events belonging to a group |
| `DELETE` | `/api/v1/events/:id` | Delete an event group |
| `GET` | `/api/v1/events/stats` | Aggregate statistics — cached 60s |
| `GET` | `/api/v1/events/performance` | Slowest groups, aging in-progress, histogram — cached 30s |

### Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/policies` | List all policies |
| `GET` | `/api/v1/policies/:id` | Get a single policy |
| `POST` | `/api/v1/policies` | Create a policy |
| `PUT` | `/api/v1/policies/:id` | Update (triggers retroactive timeout sweep) |
| `PATCH` | `/api/v1/policies/:id/toggle` | Activate or deactivate |
| `DELETE` | `/api/v1/policies/:id` | Delete |

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Sign in — sets `ag_session` httpOnly cookie |
| `POST` | `/api/v1/auth/logout` | Sign out |
| `GET` | `/api/v1/auth/me` | Current session user |
| `POST` | `/api/v1/auth/change-password` | Change own password |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/v1/auth/users[/:id]` | User CRUD (admin only) |

### SNMP

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/snmp/status` | Receiver status (enabled, port, community) |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/v1/snmp/sources[/:id]` | Trusted source management |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/v1/snmp/rules[/:id]` | Trap → policy routing rules |
| `GET` | `/api/v1/snmp/log` | Recent received traps |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` | `/api/v1/webhooks` | List / create webhooks |
| `PUT` / `DELETE` | `/api/v1/webhooks/:id` | Update / delete a webhook |
| `GET` | `/api/v1/webhooks/deliveries` | Delivery log |

### Audit, System & Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/audit` | Paginated audit log — `{ rows, total, limit, offset }` |
| `GET` / `PUT` | `/api/v1/system/config/:key` | System config (e.g. `smtp`) — admin only |
| `POST` | `/api/v1/system/config/smtp/test` | Send a test email — admin only |
| `GET` | `/api/v1/system/health` | CPU/mem/disk + table sizes — admin only |
| `GET` | `/api/v1/system/logs/:service`, `/logs/sizes` | Log viewer / rotation — admin only |
| `POST` | `/api/v1/system/logs/rotate` | Rotate logs — admin only |
| `GET` | `/api/v1/admin/export/policies` | Download policy bundle — admin only |
| `POST` | `/api/v1/admin/import/policies` | Upload policy bundle — admin only |
| `GET` | `/api/v1/admin/backup/info`, `POST /backup` | pg_dump backup — admin only |
| `POST` | `/api/v1/admin/restore` | Restore from SQL dump — admin only |
| `GET` | `/api/v1/admin/db/stats` | Table/row statistics — admin only |
| `POST` | `/api/v1/admin/db/vacuum` | VACUUM ANALYZE — admin only |
| `POST` | `/api/v1/admin/db/purge` | Purge old completed events — admin only |

`X-Cache: HIT | MISS` header is present on `/stats` and `/performance` responses.

Every ingest request requires `X-API-Key: <key>` — the key identifies which
organisation the event belongs to (`organisations.ingest_api_key`, generated
per-org; there is no global/env-var key anymore).

### Ingest example

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "<policy-uuid>",
    "body": {
      "eventType": "trade.initiated",
      "tradeRef":  "TRD-9001",
      "notional":  100000
    }
  }'
```

---

## Policies

```json
{
  "name":        "Trade Lifecycle",
  "domain":      "trade.*",
  "keyField":    "tradeRef",
  "cradleField": "eventType",
  "cradleValue": "trade.initiated",
  "graveField":  "status",
  "graveValue":  "settled",
  "timeoutMs":   86400000
}
```

| Field | Description |
|-------|-------------|
| `keyField` | Dot-notation path to the aggregation key in the event body |
| `cradleField` / `cradleValue` | Field + value that opens a new group |
| `graveField` / `graveValue` | Field + value that closes a group |
| `timeoutMs` | Auto-close groups after this many ms of inactivity (optional) |

Policies take effect immediately — no restart required.
Inactive policies return `400 POLICY_INACTIVE` on ingest.

---

## SNMP trap receiver

A built-in `dgram`-based UDP receiver with a hand-written BER/ASN.1 parser accepts SNMP traps and normalizes them into the same ingest pipeline as HTTP events, using per-policy routing rules to resolve the aggregation key. Ships with a custom MIB (`AGGRE-GATOR-MIB.txt`, enterprise OID `1.3.6.1.4.1.99999`) alongside support for standard MIB-II traps (e.g. link up/down).

```bash
SNMP_ENABLED=true       # must be true to start the receiver
SNMP_PORT=1162          # non-root friendly port
SNMP_COMMUNITY=public   # accepted community string
```

```bash
# Send a test trap
node scripts/send-trap.js --host <host> --port 1162 --list-policies
node scripts/send-trap.js --host <host> --port 1162 --scenario trade --policy <uuid>
```

Manage trusted sources and routing rules in the UI under **☰ → SNMP**.

---

## Webhooks

Configure outbound HTTP notifications (HMAC-SHA256 signed) that fire on `group_opened`, `group_completed`, and `group_timed_out` events, with automatic retry and a full delivery log. Manage from **☰ → Webhooks**.

---

## Administration

Six panels under **☰ → Administration** (admin only):

| Panel | What it does |
|-------|---------------|
| System Health | CPU/mem/disk gauges, table sizes, live log viewer |
| Audit Log | Full paginated audit log with action/actor filters |
| Import/Export | Policy JSON bundle download + upload |
| Backup | pg_dump download + SQL restore |
| DB Maintenance | Table stats, VACUUM ANALYZE, purge old data |
| Settings | SMTP config for group-timeout email alerts (sent to all admins) |

---

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/ingest.js` | HTTP ingest CLI — single events, files, or load-test bursts |
| `scripts/seedviaApi.js` | Configurable seeder that posts realistic data through the HTTP API |
| `scripts/seedviasql.js` | Generates backdated SQL inserts spread across N days, for piping into `psql` |
| `scripts/send-trap.js` | SNMP trap sender (raw dgram BER encoder — does not use net-snmp) |
| `scripts/snmp-bridge.js` | Host-side UDP→HTTP bridge, an alternative to the in-container receiver |
| `scripts/demo.js` | Interactive step-by-step demo — 4 scenarios (trade, link down/up, order, telephone call), SNMP + HTTP, Enter to advance |

```bash
# Discover policies, then ingest
node scripts/ingest.js --list-policies
node scripts/ingest.js --policy <uuid> --body '{"eventType":"trade.initiated","tradeRef":"TRD-001"}'
node scripts/ingest.js --policy <uuid> --file ./events/trade.json

# Load test — 500 events, 10ms apart, {{i}} substitution
node scripts/ingest.js --policy <uuid> \
  --body '{"eventType":"order.created","orderId":"ORD-{{i}}"}' \
  --count 500 --delay 10

# Seed via API
node scripts/seedviaApi.js
node scripts/seedviaApi.js --groups 1000 --delay 0

# Interactive demo
node scripts/demo.js --host <host> --api-key <key>
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|--------------|
| `PORT` | `3001` | Backend API port |
| `PGHOST` | — (required) | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | — (required) | Database name |
| `PGUSER` | — (required) | Database user |
| `PGPASSWORD` | — (required) | Database password |
| `PGSSL` | `false` | Enable TLS to PostgreSQL |
| `PG_POOL_MAX` | `10` | Max pool connections |
| `PG_POOL_IDLE_TIMEOUT_MS` | `30000` | Pool idle connection timeout |
| `PG_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Pool connection acquire timeout |
| `CORS_ORIGIN` | `*` | CORS origin |
| `JWT_SECRET` | dev default | JWT signing secret — **change in production** |
| `ADMIN_PASSWORD` | `admin123` | Password set for the default org's admin on first boot |
| `SNMP_ENABLED` | `true` | Enable the SNMP trap receiver |
| `SNMP_PORT` | `1162` | SNMP UDP listen port |
| `SNMP_COMMUNITY` | `public` | Accepted SNMP community string |
| `NODE_ENV` | `production` | Environment |

---

## Project structure

```
eventagg/
├── frontend/src/
│   ├── App.tsx               Full UI (~4300 lines) — login, burger menu, event groups, reports, admin panels
│   └── api.ts                Typed API client — typed functions hoisted above the plain `api` object
├── backend/src/
│   ├── index.ts               Express app, background jobs, SNMP startup, admin seeder
│   ├── config/index.ts        Zod-validated environment config
│   ├── openapi.ts             OpenAPI 3.0.3 specification
│   ├── cache.ts                In-memory TTL cache (stats 60s, performance 30s)
│   ├── db/
│   │   ├── pool.ts            pg pool, query/queryOne/withTransaction
│   │   └── migrate.ts          Sequential migration runner
│   ├── middleware/
│   │   ├── auth.ts             Ingest API key authentication
│   │   ├── session.ts          JWT cookie session, requireAuth, requireRole
│   │   ├── timeout.ts          Statement timeout helpers
│   │   └── errorHandler.ts
│   ├── routes/
│   │   ├── auth.ts             Login, logout, me, change-password, users CRUD
│   │   ├── audit.ts            Paginated audit log
│   │   ├── events.ts           Event groups, stats, performance
│   │   ├── ingest.ts           Ingest endpoint
│   │   ├── policies.ts         Policy CRUD
│   │   ├── snmp.ts             SNMP sources/rules/log CRUD + status
│   │   ├── webhooks.ts         Webhook CRUD + delivery log
│   │   ├── system.ts           Health, logs, system config, SMTP test
│   │   └── admin.ts            Import/export, backup/restore, DB maintenance
│   ├── services/
│   │   ├── auditService.ts     Fire-and-forget audit()
│   │   ├── eventService.ts     Query logic, stats, performance
│   │   ├── ingestService.ts    Ingest engine, duplicate detection, policy validation
│   │   ├── policyService.ts    Policy CRUD, retroactive timeout sweep
│   │   ├── smtpService.ts      Group-timeout email alerts
│   │   ├── userService.ts      bcryptjs auth, user CRUD
│   │   └── webhookService.ts   HMAC signing, delivery, retry
│   ├── snmp/
│   │   ├── oidMap.ts            OID→name map, AggreGator MIB constants
│   │   ├── trapNormalizer.ts    Raw trap → IngestInput
│   │   └── trapReceiver.ts      dgram UDP receiver, BER/ASN.1 parser
│   └── migrations/
│       ├── 001–009              Schema, seed policies, timeout support, partitions
│       ├── 010                  Users table
│       ├── 011                  SNMP support
│       ├── 012                  user password_changed tracking
│       ├── 013                  Webhooks
│       ├── 014                  Seed telephone-call demo policy
│       ├── 015                  system_config table
│       └── 016                  Rename event_segments → raw_events
├── scripts/                     See Scripts section above
├── AGGRE-GATOR-MIB.txt          SMIv2 MIB, enterprise OID 1.3.6.1.4.1.99999
├── sync.sh                      rsync deploy: desktop → remote server + rebuild
├── docker-compose.yml           network_mode: host (required for SNMP UDP)
├── nginx.conf                   Serves frontend on port 8080
├── supervisord.conf              Manages postgres + backend + nginx
├── entrypoint.sh                 Container startup: init DB, run migrations, start supervisord
├── OPERATIONS.md                 WAL archiving, rate limiting, partition management, tuning
└── README.md
```

---

## Operations

See [OPERATIONS.md](./OPERATIONS.md) for duplicate-detection internals, WAL archiving, rate limiting, partition management SQL, and query timeout/cache TTL reference.
