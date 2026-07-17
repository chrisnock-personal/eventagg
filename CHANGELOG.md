# Changelog

All notable changes to this project are documented in this file. Format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project doesn't yet follow strict [Semantic Versioning](https://semver.org/)
tagging, but versions are noted where meaningful.

## [Unreleased]

Nothing yet.

## [1.0.0] — Initial release

A single self-contained container (PostgreSQL 16 + Node/Express backend +
React/nginx frontend, managed by supervisord) for ingesting events from any
source, grouping them by a configurable key, and tracking cradle-to-grave
lifecycle with a dashboard and REST API.

### Added

- Policy engine (aggregation key, cradle/grave match conditions, timeouts)
  and event group lifecycle (`in_progress` → `completed` / `timed_out`),
  with quarterly-partitioned storage and duplicate-segment detection.
- REST API with an OpenAPI 3.0.3 spec and Swagger UI (`/api/v1/docs`).
- React dashboard: event groups, stats, reports, policy management,
  ingest form, and an admin burger menu.
- JWT authentication (httpOnly cookies), role-based access
  (`viewer`/`editor`/`admin`/`superadmin`), forced password change on
  first login, and a full audit log.
- SNMP trap receiver (raw `dgram` + hand-written BER/ASN.1 parser), a
  custom AggreGator MIB, `send-trap.js` and an interactive `demo.js`
  script for live demonstrations.
- Webhook/notification system: HMAC-signed delivery, retry, and a
  delivery log, configurable per policy.
- Admin screens: System Health, Audit Log, Import/Export, Backup,
  DB Maintenance, and Settings (SMTP), plus email alerts on group timeout.
- Multi-tenancy: per-organisation data isolation with JWT `orgId`, per-org
  ingest API keys, and a platform-level `superadmin` role (Phase 1); an
  Organizations admin panel, org-or-global policies, and a UI-driven
  multi-tenancy toggle replacing an env-var bootstrap (Phase 2); SNMP
  community-string-based org resolution so a trap from a brand-new source
  is attributed to the right tenant before any routing rule exists for it
  (Phase 3).
- Postgres Row-Level Security as a database-enforced backstop on
  `policies`, `users`, and `audit_log`, independent of the
  application-level org scoping every query already does.
- Automated test suite (Vitest) and GitHub Actions CI covering the ingest
  engine, multi-tenancy isolation, auth, and RLS.
- Rate limiting on login (mitigates brute-force) and consistent zod
  request validation across every route.

### Changed

- `CORS_ORIGIN` defaults to same-origin-only instead of `"*"` — this
  app's own nginx proxies the frontend and API on the same origin, so no
  documented deployment path ever needed cross-origin requests.
- `.env.example` documents every real, consumed environment variable.

### Fixed

- `runPartitionJob`'s partition-bound bind parameters (Postgres doesn't
  support them in `FOR VALUES FROM/TO` over the extended query protocol).
- Backup/restore: `pg_dump --clean --if-exists` so a backup is actually
  restorable into an already-migrated database; `psql -v ON_ERROR_STOP=1`
  so a failing restore statement doesn't silently continue past errors
  and report success.
- `docker-compose.yml` wasn't forwarding `ADMIN_PASSWORD` from the host
  environment at all, and hardcoded `PG_POOL_MAX` instead of allowing
  override — both had silently had zero effect no matter what was set.
- `seedDefaultAdmin()` silently failed to refresh the seeded admin's
  password once that account had been promoted to superadmin.
- The SNMP trap receiver wasn't establishing a database org context,
  silently breaking all AggreGator-MIB trap ingestion after `policies`
  gained Row-Level Security.

### Security

- Removed a hardcoded JWT signing secret fallback; a random secret is now
  generated per boot if `JWT_SECRET` is unset (sessions invalidate on
  restart until it's set explicitly). Added `COOKIE_SECURE` to actually
  mark the session cookie HTTPS-only once TLS is in front of the app.
  `pg_dump`/`restore`/DB-maintenance endpoints restricted to `superadmin`.
- Bumped `nodemailer` 6.9.14 → 9.0.3, resolving a high-severity `npm audit`
  finding (SMTP/CRLF injection, SSRF, TLS validation bypass).
