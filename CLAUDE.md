# Aggre/Gator — Project Context for Claude Code

## What this is
Event stream aggregation platform. Single container (PostgreSQL 16 + Node.js backend + nginx frontend) managed by supervisord.

## Repo structure
- `backend/src/` — Express API, TypeScript
- `frontend/src/` — React + Vite, TypeScript  
- `scripts/` — send-trap.js, snmp-bridge.js, seed.js, ingest.js
- `sync.sh` — deploy to remote server

## Remote server
- Host: 192.168.1.135
- UI: http://192.168.1.135:8080
- API: http://192.168.1.135:3001
- SNMP: 192.168.1.135:1162/udp
- Deploy: ./sync.sh

## Build
podman build --no-cache --layers=false -t localhost/eventagg_eventagg:latest .
podman-compose up -d  (network_mode: host, nginx on port 8080)

## What's built and working
- PostgreSQL + Express REST API + React UI
- JWT auth (httpOnly cookie), roles: viewer/editor/admin
- Aggregation policy engine (keyField, cradleField/Value, graveField/Value, timeoutMs)
- Event groups: in_progress → completed/timed_out
- SNMP trap receiver (dgram UDP, custom AggreGator MIB OID 1.3.6.1.4.1.99999)
- Audit log (writes on login/logout/ingest/policy changes)
- Force password change on first login
- Burger menu with SNMP panel, Accounts, Policies
- sync.sh for rsync deploy to remote server

## Migrations (backend/src/migrations/)
001-009: core schema, 010: users, 011: SNMP tables, 012: password_changed

## Key esbuild constraint
api.ts: NO TypeScript generics or type annotations inside the api object literal.
All typed functions must be hoisted above the api object as named functions.

## Next items
1. Webhook/notification system (POST on group complete/timeout)
2. Multi-tenancy (organisation_id on all tables)
3. Ingest form cleanup (bring modal up to mock design)
