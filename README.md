# EventAgg

A policy-driven event aggregation platform. Producers send raw event segments via a REST API — the platform handles all correlation, lifecycle detection, and persistence automatically using configurable aggregation policies.

---

## How It Works

Each **aggregation policy** defines three things, all evaluated against the event body JSON:

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

The build script detects the distro and uses the correct package manager automatically:

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
podman-compose build --build-arg BASE_IMAGE=fedora:40
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

---

## REST API

**Base URL:** `http://localhost:3001`  
**Content-Type:** `application/json` on all requests with a body.  
**OpenAPI spec:** `eventagg-openapi.json` (import into Swagger UI, Postman, or Insomnia)

---

### Health

#### `GET /health`

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-05-07T12:00:00.000Z"
}
```

---

### Policies

Policies define how events are aggregated. All three conditions (key, cradle, grave) are dot-notation paths evaluated against the event body JSON.

---

#### `GET /api/v1/policies`

List all active policies.

```bash
curl http://localhost:3001/api/v1/policies
```

```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "User Session",
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

---

#### `GET /api/v1/policies/:id`

Get a single policy by UUID.

```bash
curl http://localhost:3001/api/v1/policies/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

#### `POST /api/v1/policies`

Create a new aggregation policy.

**Required fields:** `name`, `keyField`, `cradleField`, `cradleValue`, `graveField`, `graveValue`

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
    "description": "Aggregates trade events. Closes when body.status = settled"
  }'
```

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "name": "Trade Lifecycle",
  "domain": "trade.*",
  "keyField": "tradeRef",
  "cradleField": "eventType",
  "cradleValue": "trade.initiated",
  "graveField": "status",
  "graveValue": "settled",
  "description": "Aggregates trade events. Closes when body.status = settled",
  "isActive": true,
  "createdAt": "2026-05-07T12:00:00.000Z",
  "updatedAt": "2026-05-07T12:00:00.000Z"
}
```

> **Note on field paths:** `keyField`, `cradleField`, and `graveField` use dot-notation. For example, if the event body is `{ "trade": { "ref": "TRD-001" } }`, set `keyField` to `trade.ref`. The grave condition can reference a completely different field from the cradle — e.g. `cradleField: "eventType"` and `graveField: "status"`.

---

#### `PUT /api/v1/policies/:id`

Update a policy. All fields are optional — only supplied fields are changed.

```bash
curl -X PUT http://localhost:3001/api/v1/policies/b2c3d4e5-f6a7-8901-bcde-f12345678901 \
  -H "Content-Type: application/json" \
  -d '{
    "graveValue": "settled",
    "description": "Updated description"
  }'
```

---

#### `DELETE /api/v1/policies/:id`

Soft-deactivate a policy. Historical event groups that used this policy are preserved; the policy is excluded from list results.

```bash
curl -X DELETE http://localhost:3001/api/v1/policies/b2c3d4e5-f6a7-8901-bcde-f12345678901
```

Returns `204 No Content`.

---

### Ingest

The ingest endpoint is the only write path for event data. The platform resolves the aggregation key, evaluates cradle and grave conditions, and takes the appropriate action — all from the policy definition.

---

#### `POST /api/v1/events/ingest`

Submit a single event segment.

**Response codes:**
- `201` — Cradle condition matched; new event group opened
- `200` — Segment appended to existing group, or grave matched and group promoted to completed

**Headers:**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `x-api-key` | No | Producer identifier, recorded in audit log |

**Example — cradle (opens a new group):**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.login",
      "sessionId": "sess-ABC123",
      "userId": "u001",
      "ipAddress": "192.168.1.1"
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

**Example — intermediate segment (appended to existing group):**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.action",
      "sessionId": "sess-ABC123",
      "action": "view_dashboard",
      "page": "/dashboard"
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

**Example — grave (closes the group, promotes to completed):**

```bash
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "body": {
      "eventType": "user.logout",
      "sessionId": "sess-ABC123",
      "userId": "u001",
      "reason": "explicit"
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

**Example — grave on a different field (Trade Lifecycle policy):**

```bash
# Cradle
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "body": {
      "eventType": "trade.initiated",
      "tradeRef": "TRD-9981",
      "symbol": "AAPL",
      "qty": 500
    }
  }'

# Grave — note: grave condition is body.status = "settled", not eventType
curl -X POST http://localhost:3001/api/v1/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "body": {
      "eventType": "trade.settled",
      "tradeRef": "TRD-9981",
      "status": "settled",
      "settlementDate": "2026-05-08"
    }
  }'
```

---

### Events

Query aggregated event groups. Both `in_progress_events` and `completed_events` stores are queried and results are returned unified, sorted by start time descending.

---

#### `GET /api/v1/events`

List event groups with optional filters. Results are paginated.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | `in_progress` \| `completed` \| `all` | `all` | Filter by group status |
| `policyId` | UUID | — | Filter by policy |
| `aggregationKey` | string | — | Partial match on aggregation key |
| `from` | ISO 8601 datetime | — | Groups with startTime ≥ this value |
| `to` | ISO 8601 datetime | — | Groups with startTime ≤ this value |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Page size (max 200) |

```bash
# All events
curl "http://localhost:3001/api/v1/events"

# Completed events for a specific policy
curl "http://localhost:3001/api/v1/events?status=completed&policyId=a1b2c3d4-e5f6-7890-abcd-ef1234567890"

# Filter by aggregation key partial match
curl "http://localhost:3001/api/v1/events?aggregationKey=sess-ABC"

# Filter by time range
curl "http://localhost:3001/api/v1/events?from=2026-05-07T00:00:00Z&to=2026-05-07T23:59:59Z"

# Paginated
curl "http://localhost:3001/api/v1/events?page=2&limit=10"
```

```json
{
  "data": [
    {
      "id": "f1e2d3c4-b5a6-7890-abcd-123456789012",
      "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "policyName": "User Session",
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

---

#### `GET /api/v1/events/:id`

Get a single event group with all its segments.

```bash
curl http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012
```

```json
{
  "id": "f1e2d3c4-b5a6-7890-abcd-123456789012",
  "policyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "policyName": "User Session",
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
      "body": {
        "eventType": "user.login",
        "sessionId": "sess-ABC123",
        "userId": "u001",
        "ipAddress": "192.168.1.1"
      }
    },
    {
      "eventId": "b1c2d3e4-f5a6-7890-abcd-123456789013",
      "sequence": 2,
      "isCradle": false,
      "isGrave": false,
      "timestamp": "2026-05-07T12:02:15.000Z",
      "body": {
        "eventType": "user.action",
        "sessionId": "sess-ABC123",
        "action": "view_dashboard"
      }
    },
    {
      "eventId": "c1d2e3f4-a5b6-7890-abcd-123456789014",
      "sequence": 3,
      "isCradle": false,
      "isGrave": true,
      "timestamp": "2026-05-07T12:04:32.000Z",
      "body": {
        "eventType": "user.logout",
        "sessionId": "sess-ABC123",
        "userId": "u001"
      }
    }
  ]
}
```

---

#### `GET /api/v1/events/:id/segments`

List segments only for an event group, ordered by sequence ascending.

```bash
curl http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012/segments
```

Returns an array of `SegmentDetail` objects (same shape as `segments` in the detail response above).

---

#### `DELETE /api/v1/events/:id`

Soft-delete an event group. The deletion is recorded in the audit log; no data is physically removed.

```bash
curl -X DELETE http://localhost:3001/api/v1/events/f1e2d3c4-b5a6-7890-abcd-123456789012
```

Returns `204 No Content`.

---

### Error responses

All errors return a consistent JSON shape:

```json
{
  "error": "Human-readable message"
}
```

Validation errors include field-level detail:

```json
{
  "error": "Validation error",
  "details": [
    {
      "field": "policyId",
      "message": "policyId must be a valid UUID"
    }
  ]
}
```

| Status | Meaning |
|---|---|
| `400` | Validation error — check `details` |
| `404` | Resource not found |
| `422` | Business logic error — e.g. key path not resolvable, grave with no open group |
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
006_seed_policies.sql          ← seeds the 4 default policies
```

### Compliance

- WAL archiving is enabled (`wal_level = replica`) — configure `archive_command` in `postgresql.conf` to ship WAL to durable storage for point-in-time recovery
- `completed_events` and `audit_log` have `DELETE` revoked from the application role — deletions must go through the admin role
- `completed_events` is partitioned by quarter — old partitions can be detached and archived without expensive `DELETE` operations

---

## Project Structure

```
eventagg/
├── Dockerfile              Multi-stage build (frontend + backend + runtime)
├── docker-compose.yml      Single service, all ports exposed
├── entrypoint.sh           Init: postgres setup → migrations → supervisord
├── install-packages.sh     Distro-aware package installer (apt / dnf)
├── supervisord.conf        Manages postgres, node, nginx as supervised processes
├── nginx.conf              Serves /app/frontend/dist, proxies /api/* to :3001
├── .env.example            Copy to .env before first run
├── eventagg-openapi.json   OpenAPI 3.1 specification
│
├── backend/
│   └── src/
│       ├── config/         Env var loading and validation (zod)
│       ├── db/             pg connection pool, migration runner
│       ├── migrations/     001–006 SQL files
│       ├── routes/         Express route handlers
│       │   ├── policies.ts
│       │   ├── events.ts
│       │   └── ingest.ts
│       ├── services/       Business logic
│       │   ├── ingestService.ts   Core aggregation engine (SELECT FOR UPDATE, atomic promotion)
│       │   ├── policyService.ts   Policy CRUD + audit logging
│       │   └── eventService.ts    Event group queries
│       ├── middleware/     Error handler
│       ├── types/          Shared TypeScript interfaces
│       └── index.ts        Express app entry point
│
└── frontend/
    └── src/
        ├── api.ts          Typed fetch client for all backend endpoints
        ├── App.tsx         React UI — policy editor, event table, ingest modal
        └── main.tsx        Entry point
```

---

## Troubleshooting

**Port already in use**
```bash
# Change HOST_PORT, API_PORT, or PG_PORT in .env then restart
podman-compose down && podman-compose up
```

**Port 80 permission denied (rootless Podman)**
```bash
# Use a high port in .env
HOST_PORT=9090
# or lower the unprivileged port start
sudo sysctl net.ipv4.ip_unprivileged_port_start=80
```

**SELinux volume permission errors (RHEL/Rocky/Alma)**
```yaml
# Add :z to the volume in docker-compose.yml
volumes:
  - pgdata:/var/lib/postgresql/data:z
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
