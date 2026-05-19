# Aggre/Gator

> *event streams, swallowed whole*

Aggre/Gator is an intelligent event stream aggregation platform. It ingests events from any source, groups related events by a configurable key, tracks the complete cradle-to-grave lifecycle of each group, and surfaces real-time insights through a built-in dashboard and REST API.

---

## What it does

Modern systems produce floods of related events that arrive fragmented, out of order, and from many sources. Aggre/Gator solves this by:

- **Accepting events from any producer** — a single HTTP endpoint handles APIs, queues, webhooks, batch jobs and IoT devices
- **Grouping events automatically** by a configurable field in the event body (e.g. `tradeRef`, `orderId`, `sessionId`)
- **Tracking lifecycle from first to last event** using user-defined cradle (open) and grave (close) conditions per policy
- **Auto-closing stale groups** via configurable per-policy timeouts with retroactive sweep
- **Surfacing insights** through real-time charts, per-policy health cards, duration histograms, and performance tables
- **Full headless access** — every core feature is available via the REST API with no UI required

---

## Quick start

```bash
# Build and run (requires Podman + podman-compose)
podman build --no-cache --layers=false -t localhost/eventagg_eventagg:latest .
podman-compose up -d

# UI (login: admin / admin123)
open http://localhost:9090

# API docs — Swagger UI
open http://localhost:3001/api/v1/docs

# Health check
curl http://localhost:3001/health
```

---

## Architecture

```
Producers (any source)
    │
    ▼
POST /api/v1/events/ingest          rate-limited · API-key-gated
    │
    ▼
Policy Engine
  ├── Extracts aggregation key      configurable dot-notation field path
  ├── Evaluates cradle condition    opens a new event group
  ├── Appends segment               links event to existing group
  └── Evaluates grave condition     promotes group to completed
    │
    ▼
PostgreSQL 16
  ├── in_progress_events            hot store for open groups
  ├── completed_events              quarterly partitions, auto-managed
  └── event_segments                GIN-indexed JSONB, duplicate-guarded
    │
    ▼
REST API + React UI                 headless or browser, JWT session auth
```

**Background jobs** (in-process):

| Job | Interval | Purpose |
|-----|----------|---------|
| Timeout sweep | 60s | Closes groups that exceed their policy timeout |
| Partition manager | 24h | Pre-creates the next 3 quarters of partitions |

---

## Authentication

The UI requires login. Credentials are stored in the `users` table with bcrypt-hashed passwords.

Default account created on first boot: `admin` / `admin123`

Change the password or set `ADMIN_PASSWORD` env var before deploying.

| Role | Permissions |
|------|-------------|
| `viewer` | Read-only access to events and reports |
| `editor` | Ingest events, manage policies |
| `admin` | Full access including account management |

Account management (add, disable, remove users, change roles) is in the **☰ burger menu**, top-right of the UI.

---

## REST API

Full interactive docs at `GET /api/v1/docs` (Swagger UI) · Spec at `GET /api/v1/openapi.json`

### Events

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/events/ingest` | Ingest an event segment |
| `GET` | `/api/v1/events` | List and filter event groups |
| `GET` | `/api/v1/events/:id` | Event group detail with all segments |
| `GET` | `/api/v1/events/stats` | Aggregate statistics — cached 60s |
| `GET` | `/api/v1/events/performance` | Slowest groups, aging in-progress, histogram — cached 30s |

### Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/policies` | List all policies |
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
| `GET` | `/api/v1/auth/users` | List users (admin only) |
| `POST` | `/api/v1/auth/users` | Create user (admin only) |
| `PUT` | `/api/v1/auth/users/:id` | Update user (admin only) |
| `DELETE` | `/api/v1/auth/users/:id` | Delete user (admin only) |

`X-Cache: HIT | MISS` header is present on `/stats` and `/performance` responses.

Set `INGEST_API_KEY` env var to require `X-API-Key: <key>` on all ingest requests.

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

## Scripts

### Ingest CLI

```bash
# Discover policies
node scripts/ingest.js --list-policies

# Single event
node scripts/ingest.js --policy <uuid> \
  --body '{"eventType":"trade.initiated","tradeRef":"TRD-001"}'

# From a JSON file
node scripts/ingest.js --policy <uuid> --file ./events/trade.json

# Load test — 500 events, 10ms apart, {{i}} substitution
node scripts/ingest.js --policy <uuid> \
  --body '{"eventType":"order.created","orderId":"ORD-{{i}}"}' \
  --count 500 --delay 10
```

### Seeder

```bash
node scripts/seed.js                                        # 200 groups, realistic data
node scripts/seed.js --load-test                            # 5000 groups, no delay
node scripts/seed.js --groups 1000 --segs-min 3 --segs-max 10 --open-pct 20
node scripts/seed.js --api https://your-instance.example.com
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend API port |
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `eventagg` | Database name |
| `PGUSER` | `eventagg_user` | Database user |
| `PGPASSWORD` | — | Database password |
| `JWT_SECRET` | dev default | JWT signing secret — **change in production** |
| `ADMIN_PASSWORD` | `admin123` | Password set for the default admin on first boot |
| `INGEST_API_KEY` | — | API key for ingest endpoint (disabled if unset) |
| `NODE_ENV` | `production` | Environment |

---

## Project structure

```
eventagg/
├── frontend/src/
│   ├── App.tsx               UI — login, burger menu, event groups, reports
│   └── api.ts                Typed API client and interfaces
├── backend/src/
│   ├── index.ts              Express app, background jobs, Swagger UI, admin seeder
│   ├── openapi.ts            OpenAPI 3.0.3 specification
│   ├── cache.ts              In-memory TTL cache
│   ├── db/
│   │   ├── pool.ts           pg pool, withTransaction, withStatementTimeout
│   │   └── migrate.ts        Sequential migration runner
│   ├── middleware/
│   │   ├── auth.ts           Ingest API key authentication
│   │   ├── session.ts        JWT cookie session, requireAuth, requireRole
│   │   ├── timeout.ts        Statement timeout helpers
│   │   └── errorHandler.ts
│   ├── routes/
│   │   ├── auth.ts           Login, logout, me, users CRUD
│   │   ├── events.ts         Event groups, stats, performance
│   │   ├── ingest.ts         Ingest endpoint
│   │   └── policies.ts       Policy CRUD
│   ├── services/
│   │   ├── eventService.ts   Query logic, stats, performance
│   │   ├── ingestService.ts  Ingest engine, duplicate detection, policy validation
│   │   ├── policyService.ts  Policy CRUD, retroactive timeout sweep
│   │   └── userService.ts    bcryptjs auth, user CRUD
│   └── migrations/
│       ├── 001–006           Schema and seed policies
│       ├── 007               Timeout support (status, close_reason, last_segment_at)
│       ├── 008               duration_ms INT→BIGINT fix
│       ├── 009               Partitions, duplicate guard, covering indexes
│       └── 010               Users table
├── scripts/
│   ├── ingest.js             Ingest CLI
│   └── seed.js               Configurable seeder
├── OPERATIONS.md             WAL archiving, async queue, rate limiting, tuning
└── README.md
```

---

## Operations

See [OPERATIONS.md](./OPERATIONS.md) for WAL archiving, async queue architecture (pg-boss), rate limiting, partition management SQL, query timeout and cache TTL reference, and duplicate detection limitations.
