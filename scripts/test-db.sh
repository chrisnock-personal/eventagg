#!/usr/bin/env bash
# ─── Aggre/Gator Test Database ────────────────────────────────────────────────
# Spins up (or tears down) a throwaway Postgres 16 container for running the
# backend test suite locally. Mirrors the container used to develop/verify
# the test suite itself — nothing here is meant to persist.
#
# Usage:
#   ./scripts/test-db.sh up      # start the container
#   ./scripts/test-db.sh down    # stop and remove it

set -e

CONTAINER=eventagg-test-db
PORT="${TEST_DB_PORT:-15432}"
ENGINE="${CONTAINER_ENGINE:-podman}"

case "$1" in
  up)
    # Deliberately does NOT set POSTGRES_USER=eventagg_user — the vanilla
    # postgres image's bootstrap user is always a superuser, and superusers
    # always bypass Row-Level Security regardless of FORCE ROW LEVEL
    # SECURITY, which would make any RLS test pass/fail for the wrong
    # reason. Mirrors entrypoint.sh's real production setup instead: a
    # `postgres` superuser only for bootstrapping, and a separate,
    # genuinely non-superuser eventagg_user (CREATEDB, not SUPERUSER) that
    # the app — and this test suite — actually connects as.
    "$ENGINE" run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD=postgres_admin_pass \
      -e POSTGRES_DB=eventagg \
      -p "${PORT}:5432" \
      postgres:16 >/dev/null

    echo "Waiting for Postgres to accept connections..."
    for i in $(seq 1 30); do
      if "$ENGINE" exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
      sleep 1
    done

    "$ENGINE" exec "$CONTAINER" psql -U postgres -d eventagg -v ON_ERROR_STOP=1 -c "
      DO \$\$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eventagg_user') THEN
          CREATE USER eventagg_user WITH PASSWORD 'eventagg_pass' CREATEDB;
        END IF;
      END
      \$\$;
      ALTER DATABASE eventagg OWNER TO eventagg_user;
      GRANT ALL PRIVILEGES ON DATABASE eventagg TO eventagg_user;
    " >/dev/null

    echo "Test Postgres started on port ${PORT} (eventagg_user is a non-superuser role, matching production)."
    echo ""
    echo "Export these before running the suite:"
    echo "  export PGHOST=localhost PGPORT=${PORT} PGDATABASE=eventagg PGUSER=eventagg_user PGPASSWORD=eventagg_pass"
    echo "  cd backend && npm test"
    ;;
  down)
    "$ENGINE" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "Test Postgres stopped and removed."
    ;;
  *)
    echo "Usage: $0 {up|down}"
    echo "  Set CONTAINER_ENGINE=docker to use Docker instead of Podman."
    echo "  Set TEST_DB_PORT to change the host port (default 15432)."
    exit 1
    ;;
esac
