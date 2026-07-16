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
    "$ENGINE" run -d --name "$CONTAINER" \
      -e POSTGRES_USER=eventagg_user \
      -e POSTGRES_PASSWORD=eventagg_pass \
      -e POSTGRES_DB=eventagg \
      -p "${PORT}:5432" \
      postgres:16 >/dev/null
    echo "Test Postgres started on port ${PORT}."
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
