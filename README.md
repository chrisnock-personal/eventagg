# Aggre/Gator

> **event streams, swallowed whole**

Aggre/Gator is an intelligent event aggregation platform. It ingests events from any source, groups related events together by a configurable key, tracks the complete cradle-to-grave lifecycle of each group, and surfaces real-time insights through a built-in dashboard and REST API.

---

## What it does

Modern systems produce floods of related events that arrive fragmented, out of order, and from many sources. Aggre/Gator solves this by:

- **Accepting events from any producer** via a single HTTP endpoint — APIs, message queues, webhooks, batch jobs, IoT devices
- **Grouping events automatically** by a configurable field in the event body (e.g. `tradeRef`, `orderId`, `sessionId`)
- **Tracking lifecycle from first to last event** using user-defined cradle (open) and grave (close) conditions per policy
- **Auto-closing stale groups** via configurable per-policy timeouts that retroactively apply to existing data
- **Surfacing insights** through real-time charts, per-policy health cards, duration histograms, and performance tables

---

## Quick start

\`\`\`bash
# Build and run (requires Podman + podman-compose)
podman build --no-cache --layers=false -t localhost/eventagg_eventagg:latest .
podman-compose up -d

# UI
open http://localhost:9090

# API docs (Swagger UI)
open http://localhost:3001/api/v1/docs

# Health check
curl http://localhost:3001/health
\`\`\`

---

## Architecture

\`\`\`
Producers (any source)
    │
    ▼
POST /api/v1/events/ingest
    │
    ▼
Policy Engine
  ├── Extracts aggregation key  (configurable field path)
  ├── Evaluates cradle condition (opens group)
  ├── Appends to existing group
  └── Evaluates grave condition  (promotes to completed)
    │
    ▼
PostgreSQL 16
  ├── in_progress_events          (hot store)
  ├── completed_events (partitioned, auto-managed quarterly)
  └── event_segments  (GIN-indexed JSON)
    │
    ▼
REST API + React UI              (headless or browser)
\`\`\`

Background jobs (in-process): timeout sweep every 60s, partition manager every 24h.

---

## REST API

Full interactive docs at \`GET /api/v1/docs\` (Swagger UI).

| Method | Path | Description |
|--------|------|-------------|
| \`POST\` | \`/api/v1/events/ingest\` | Ingest an event |
| \`GET\` | \`/api/v1/events\` | List & filter event groups |
| \`GET\` | \`/api/v1/events/:id\` | Detail + all segments |
| \`GET\` | \`/api/v1/events/stats\` | Aggregate statistics (60s cache) |
| \`GET\` | \`/api/v1/events/performance\` | Performance metrics (30s cache) |
| \`GET\` | \`/api/v1/policies\` | List policies |
| \`POST\` | \`/api/v1/policies\` | Create policy |
| \`PUT\` | \`/api/v1/policies/:id\` | Update policy |
| \`PATCH\` | \`/api/v1/policies/:id/toggle\` | Activate / deactivate |
| \`DELETE\` | \`/api/v1/policies/:id\` | Delete policy |

Set \`INGEST_API_KEY\` env var to require \`X-API-Key\` on ingest requests.

---

## Scripts

\`\`\`bash
# Ingest CLI
node scripts/ingest.js --list-policies
node scripts/ingest.js --policy <uuid> --body '{"eventType":"trade.initiated","tradeRef":"T-001"}'
node scripts/ingest.js --policy <uuid> --body '...' --count 500 --delay 10

# Seeder
node scripts/seed.js                          # 200 groups, realistic data
node scripts/seed.js --load-test              # 5000 groups, no delay
node scripts/seed.js --groups 1000 --open-pct 20
\`\`\`

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| \`PORT\` | \`3001\` | Backend API port |
| \`PGHOST\` | \`localhost\` | PostgreSQL host |
| \`PGDATABASE\` | \`eventagg\` | Database name |
| \`PGUSER\` | \`eventagg_user\` | Database user |
| \`PGPASSWORD\` | — | Database password |
| \`INGEST_API_KEY\` | — | API key for ingest (disabled if unset) |

---

## Operations

See [OPERATIONS.md](./OPERATIONS.md) for WAL archiving, async queue architecture, rate limiting, partition management, and tuning reference.
