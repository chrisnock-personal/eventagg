# EventAgg

A policy-driven event aggregation platform. Producers send raw event segments via a REST API — the platform handles all correlation, lifecycle detection, and persistence automatically using configurable aggregation policies.

---

## How It Works

Each **aggregation policy** defines three conditions, all evaluated by dot-notation path against the incoming event body JSON:

| Condition | What it does |
|---|---|
| **Key field** (dot-path) | Extracts a value from the body to use as the correlation key |
| **Cradle condition** (field + value) | When matched, opens a new event group in `in_progress_events` |
| **Grave condition** (field + value) | When matched, promotes the group to `completed_events` |

Producers send a plain JSON payload with a `policyId`. No lifecycle flags, no awareness of open/closed state — the platform evaluates everything server-side.

```
Producer → POST /api/v1/events/ingest → Policy evaluated → Group opened / appended / promoted
```

---

## Quick Start

```bash
git clone <repo-url>
cd eventagg

cp .env.example .env
# Edit .env — set passwords, adjust ports if needed

podman-compose up --build
# or: docker compose up --build
```

On first run the container automatically:
1. Initialises a PostgreSQL 16 data directory
2. Creates the application user and database if they don't exist
3. Configures PostgreSQL for remote connections
4. Runs all database migrations in order
5. Starts PostgreSQL, the Node.js API, and nginx under supervisord

| Service | Default URL |
|---|---|
| **Web UI** | http://localhost:9090 |
| **REST API** | http://localhost:3001/api/v1 |
| **PostgreSQL** | localhost:5432 |
| **Health check** | http://localhost:3001/health |

---

## Web UI

The interface is accessible at `http://localhost:9090` and provides:

- **Stats bar** — live counts of event groups, completed, in-progress, policies, and segments
- **Filters** — filter by status, policy, aggregation key, and date range (Last 24h / 7d / 30d / 6m / custom)
- **Auto-refresh** — toggle in the header to poll for new events every 10 seconds
- **Event Groups tab** — paginated table of all event groups with resizable, hideable columns
- **Segments tab** — flat list of all individual segments across all visible groups
- **Column controls** — drag column dividers to resize; use the Columns button to show/hide any column
- **Event detail panel** — click any row to view full metadata, applied policy conditions, and all segments with their JSON bodies
- **Policies panel** — create, edit, and deactivate aggregation policies; shows the copyable policy UUID for use in ingest requests
- **Ingest modal** — test-fire event segments directly from the UI with live resolution preview

### Example data

A seed script is provided to populate the four example policies with realistic data:

```bash
psql -h localhost -p 5432 -U eventagg_user -d eventagg -f seed_example_events.sql
```

---

## Configuration

Copy `.env.example` to `.env` and set the following:

| Variable | Default | Description |
|---|---|---|
| `PGDATABASE` | `eventagg` | Database name |
| `PGUSER` | `eventagg_user` | Application database user |
| `PGPASSWORD` | — | Application user password (**change this**) |
| `POSTGRES_PASSWORD` | — | PostgreSQL superuser password (**change this**) |
| `HOST_PORT` | `9090` | Host port for the web UI |
| `API_PORT` | `3001` | Host port for direct API access |
| `PG_PORT` | `5432` | Host port for PostgreSQL |
| `NODE_ENV` | `production` | Node environment |
| `BASE_IMAGE` | `ubuntu:22.04` | Base Linux image for the container build |

### Supported base images

The build script detects the Linux distribution at build time and uses the correct package manager and repository configuration automatically:

```
ubuntu:22.04  ubuntu:24.04
debian:12     debian:11
fedora:40     fedora:39
rockylinux:9  rockylinux:8
almalinux:9   almalinux:8
amazonlinux:2023
```

```bash
# Build on a different distro
podman-compose build --build-arg BASE_IMAGE=rockylinux:9
podman-compose up
```

---

## Container Management

```bash
# Start (foreground)
podman-compose up --build

# Start (detached)
podman-compose up -d --build

# View all logs
podman-compose logs -f

# View logs per process
podman exec eventagg tail -f /var/log/supervisor/backend.log
podman exec eventagg tail -f /var/log/supervisor/postgres.log
podman exec eventagg tail -f /var/log/supervisor/nginx.log

# Check supervisor process status
podman exec eventagg supervisorctl status

# Open a shell
podman exec -it eventagg bash

# Open a psql session
podman exec -it eventagg psql -U eventagg_user -d eventagg

# Stop (preserves data volume)
podman-compose down

# Full reset — wipes the PostgreSQL volume
podman-compose down -v

# Rebuild image from scratch
podman-compose down --rmi all
podman-compose up --build
```

### Remote PostgreSQL access

The database is accessible on the host at the configured `PG_PORT`:

```bash
psql -h localhost -p 5432 -U eventagg_user -d eventagg

# Connection string
postgresql://eventagg_user:<password>@localhost:5432/eventagg
```

Any PostgreSQL client (DBeaver, TablePlus, DataGrip, pgAdmin) can connect with the same credentials.

---

## REST API

**Base URL:** `http://localhost:3001`
**Content-Type:** `application/json` on all requests with a body.
**OpenAPI spec:** `eventagg-openapi.json` — import into Swagger UI, Postman, or Insomnia.

---

### Health

#### `GET /health`

```bash
curl http://localhost:3001/health
```

```json
{ "status": "ok", "timestamp": "2026-05-07T12:00:00.000Z" }
```

---

### Policies

#### `GET /api/v1/policies`

List all active policies.

```bash
curl http://localhost:3001/api/v1/policies
```

```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "EXAMPLE - User Session",
    "domain": "user.*",
    "keyField": "sessionId",
    "cradleField": "eventType",
    "cradleValue": "user.login",
    "graveField": "eventType",
    "graveValue": "user.logout",
    "description": "Aggregates user session events keyed on body.sessionId",
    "isActive": true,
    "createdAt": "2026-05-07T10:00:00.000Z",
    "updatedAt": "2026-05-07T10:00:00.000Z"
  }
]
```

#### `GET /api/v1/policies/:id`

Get a single policy by UUID.

```bash
curl http://localhost:3001/api/v1/policies/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

#### `POST /api/v1/policies`

Create a new aggregation policy.

**Required:** `name`, `keyField`, `cradleField`, `cradleValue`, `graveField`, `graveValue`

```bash
curl -X POST http://localhost:3001/api/v1/policies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Trade Lifecycle",
    "domain": "trade.*",
    "keyField": "tradeRef",
    "cradleField": "eventType",
    "cradleValue": "trade.initiated",
    "graveField": "status",
    "graveValue": "settled",
    "description": "Closes when body.status = settled — note: different field from cradle"
  }'
```

> **Field paths use dot-notation.** `keyField: "trade.reference"` resolves `body.trade.reference`. The grave condition can reference a completely different field from the cradle.

#### `PUT /api/v1/policies/:id`

Update a policy. All fields optional — only supplied fields are changed.

```bash
curl -X PUT http://localhost:3001/api/v1/policies/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -d '{ "graveValue": "user.session_expired" }'
```

#### `DELETE /api/v1/policies/:id`

Soft-deactivate a policy. Historical event groups are preserved.

```bash
curl -X DELETE http://localhost:3001/api/v1/policies/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

Returns `204 No Content`.

---

### Ingest

The ingest endpoint is the only write path for event data. The platform resolves the aggregation key, evaluates cradle and grave conditions, and takes the appropriate action — all from the policy. No lifecycle flags are required from the producer.

#### `POST /api/v1/events/ingest`

**Response codes:**
- `201` — Cradle matched; new event group opened in `in_progress_events`
- `200` — Segment appended to existing group, or grave matched and group promoted to `completed_events`

**Example — cradle (opens a new group):**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.login",
      "sessionId": "sess-ABC123",
      "userId": "u001"
    }
  }'
```

```json
{
  "groupId": "f1e2d3c4-b5a6-7890-abcd-123456789012",
  "segmentId": "a9b8c7d6-e5f4-3210-abcd-fedcba987654",
  "aggregationKey": "sess-ABC123",
  "isCradle": true,
  "isGrave": false,
  "action": "group_opened",
  "status": "in_progress"
}
```

**Example — intermediate segment:**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.action",
      "sessionId": "sess-ABC123",
      "action": "view_dashboard"
    }
  }'
```

```json
{
  "groupId": "f1e2d3c4-b5a6-7890-abcd-123456789012",
  "segmentId": "b1c2d3e4-f5a6-7890-abcd-123456789013",
  "aggregationKey": "sess-ABC123",
  "isCradle": false,
  "isGrave": false,
  "action": "segment_appended",
  "status": "in_progress"
}
```

**Example — grave (closes and promotes the group):**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.logout",
      "sessionId": "sess-ABC123",
      "userId": "u001"
    }
  }'
```

```json
{
  "groupId": "f1e2d3c4-b5a6-7890-abcd-123456789012",
  "segmentId": "c1d2e3f4-a5b6-7890-abcd-123456789014",
  "aggregationKey": "sess-ABC123",
  "isCradle": false,
  "isGrave": true,
  "action": "group_promoted",
  "status": "completed"
}
```

**Example — grave on a different field (Trade Lifecycle):**

```bash
# The Trade Lifecycle policy has: cradleField=eventType, graveField=status
# The grave fires on body.status = "settled", not on eventType

curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "<trade-policy-uuid>",
    "body": {
      "eventType": "trade.settled",
      "tradeRef": "TRD-9001",
      "status": "settled",
      "netAmount": 91170.00
    }
  }'
```

---

### Events

#### `GET /api/v1/events`

List event groups with optional filters. Results from both `in_progress_events` and `completed_events` are returned unified, sorted by start time descending.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | `in_progress` \| `completed` \| `all` | `all` | Filter by group status |
| `policyId` | UUID | — | Filter by policy |
| `aggregationKey` | string | — | Partial match (case-insensitive) |
| `from` | ISO 8601 datetime | — | Groups with startTime ≥ this value |
| `to` | ISO 8601 datetime | — | Groups with startTime ≤ this value |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Page size (max 200) |

```bash
# All events
curl "http://localhost:3001/api/v1/events"

# In-progress only, last 24 hours
curl "http://localhost:3001/api/v1/events?status=in_progress&from=2026-05-06T23:00:00.000Z&to=2026-05-07T22:59:59.999Z"

# Filter by key partial match
curl "http://localhost:3001/api/v1/events?aggregationKey=TRD-9"

# Paginated
curl "http://localhost:3001/api/v1/events?page=2&limit=10"
```

```json
{
  "data": [
    {
      "id": "f1e2d3c4-b5a6-7890-abcd-123456789012",
      "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "policyName": "EXAMPLE - User Session",
      "aggregationKey": "sess-ABC123",
      "keyField": "sessionId",
      "status": "completed",
      "segmentCount": 3,
      "startTime": "2026-05-07T12:00:00.000Z",
      "endTime": "2026-05-07T12:04:32.000Z",
      "durationMs": 272000
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

#### `GET /api/v1/events/:id`

Get a single event group with all segments.

```bash
curl http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012
```

```json
{
  "id": "f1e2d3c4-b5a6-7890-abcd-123456789012",
  "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "policyName": "EXAMPLE - User Session",
  "aggregationKey": "sess-ABC123",
  "keyField": "sessionId",
  "status": "completed",
  "segmentCount": 3,
  "startTime": "2026-05-07T12:00:00.000Z",
  "endTime": "2026-05-07T12:04:32.000Z",
  "durationMs": 272000,
  "segments": [
    {
      "eventId": "a9b8c7d6-e5f4-3210-abcd-fedcba987654",
      "sequence": 1,
      "isCradle": true,
      "isGrave": false,
      "timestamp": "2026-05-07T12:00:00.000Z",
      "body": { "eventType": "user.login", "sessionId": "sess-ABC123", "userId": "u001" }
    },
    {
      "eventId": "b1c2d3e4-f5a6-7890-abcd-123456789013",
      "sequence": 2,
      "isCradle": false,
      "isGrave": false,
      "timestamp": "2026-05-07T12:02:15.000Z",
      "body": { "eventType": "user.action", "sessionId": "sess-ABC123", "action": "view_dashboard" }
    },
    {
      "eventId": "c1d2e3f4-a5b6-7890-abcd-123456789014",
      "sequence": 3,
      "isCradle": false,
      "isGrave": true,
      "timestamp": "2026-05-07T12:04:32.000Z",
      "body": { "eventType": "user.logout", "sessionId": "sess-ABC123", "userId": "u001" }
    }
  ]
}
```

#### `GET /api/v1/events/:id/segments`

List segments only for an event group, ordered by sequence ascending.

```bash
curl http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012/segments
```

#### `DELETE /api/v1/events/:id`

Soft-delete an event group. Recorded in audit log; no data physically removed.

```bash
curl -X DELETE http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012
```

Returns `204 No Content`.

---

### Error responses

All errors return a consistent JSON shape:

```json
{ "error": "Human-readable message" }
```

Validation errors include field-level detail:

```json
{
  "error": "Validation error",
  "details": [{ "field": "policyId", "message": "policyId must be a valid UUID" }]
}
```

| Status | Meaning |
|---|---|
| `400` | Validation error |
| `404` | Resource not found |
| `422` | Business logic error (key path unresolvable, grave with no open group) |
| `500` | Internal server error |

---

## Database

PostgreSQL 16, running inside the container on port 5432 (mapped to `PG_PORT` on the host).

### Tables

| Table | Purpose |
|---|---|
| `policies` | Aggregation policy definitions |
| `in_progress_events` | Open event groups awaiting a grave segment |
| `event_segments` | Individual segments (normalised, insert-only) |
| `completed_events` | Closed groups (append-only, partitioned by quarter) |
| `audit_log` | Immutable record of every state transition |
| `schema_migrations` | Applied migration tracking |

### Migrations

Migrations in `backend/src/migrations/` are numbered SQL files applied automatically on startup. Already-applied migrations are skipped. To add a new migration, create `007_your_change.sql`.

```
001_create_policies.sql
002_create_in_progress_events.sql
003_create_completed_events.sql
004_create_event_segments.sql
005_create_audit_log.sql
006_seed_policies.sql          ← seeds 4 EXAMPLE policies on first run
```

### Compliance

- WAL archiving is enabled (`wal_level = replica`) — configure `archive_command` in `postgresql.conf` to ship WAL to durable storage
- `completed_events` and `audit_log` have `DELETE` revoked from the application role
- `completed_events` is partitioned by quarter for efficient archival

---

## Project Structure

```
eventagg/
├── Dockerfile              Multi-stage build — frontend + backend + runtime
├── docker-compose.yml      Single service, all ports exposed
├── entrypoint.sh           Init: postgres setup → migrations → supervisord
├── install-packages.sh     Distro-aware package installer (apt / dnf)
├── supervisord.conf        Manages postgres, node, nginx as supervised processes
├── nginx.conf              Serves /app/frontend/dist, proxies /api/* to :3001
├── .env.example            Copy to .env before first run
├── eventagg-openapi.json   OpenAPI 3.1 specification
├── eventagg-database-schema.md  Full database schema documentation
├── seed_example_events.sql Example data for the four EXAMPLE policies
│
├── backend/
│   └── src/
│       ├── config/         Env var loading and validation (zod)
│       ├── db/             pg connection pool, migration runner
│       ├── migrations/     001–006 SQL files (auto-applied on startup)
│       ├── routes/         Express route handlers
│       │   ├── policies.ts
│       │   ├── events.ts
│       │   └── ingest.ts
│       ├── services/
│       │   ├── ingestService.ts   Aggregation engine (SELECT FOR UPDATE, atomic promotion)
│       │   ├── policyService.ts   Policy CRUD + audit logging
│       │   └── eventService.ts    Event group + segment queries
│       ├── middleware/     Error handler
│       ├── types/          Shared TypeScript interfaces
│       └── index.ts        Express app entry point
│
└── frontend/
    └── src/
        ├── api.ts          Typed fetch client for all backend endpoints
        ├── App.tsx         React UI (tabs, resizable columns, column visibility)
        └── main.tsx        Entry point
```

---

## Troubleshooting

**Port already in use**
```bash
# Change HOST_PORT, API_PORT, or PG_PORT in .env then restart
podman-compose down && podman-compose up
```

**Port 80 / ports below 1024 (rootless Podman)**
```bash
# Default UI port is 9090 which avoids this. If you change HOST_PORT below 1024:
sudo sysctl net.ipv4.ip_unprivileged_port_start=80
```

**SELinux volume permission errors (RHEL / Rocky / Alma)**
```yaml
# Add :z label to the volume in docker-compose.yml
volumes:
  - pgdata:/var/lib/postgresql/data:z
```

**Stale container from a previous failed run**
```bash
podman container prune -f
podman-compose up
```

**Full reset (wipe all data and rebuild)**
```bash
podman-compose down -v --rmi all
podman-compose up --build
```

**Check what's running inside the container**
```bash
podman exec eventagg supervisorctl status
```

Expected output:
```
backend    RUNNING   pid 82, uptime 0:01:23
nginx      RUNNING   pid 83, uptime 0:01:23
postgres   RUNNING   pid 81, uptime 0:01:23
```
