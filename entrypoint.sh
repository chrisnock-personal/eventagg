#!/usr/bin/env bash
set -euo pipefail

# ─── Colour helpers ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[eventagg]${NC} $*"; }
warn() { echo -e "${YELLOW}[eventagg]${NC} $*"; }
err()  { echo -e "${RED}[eventagg]${NC} $*" >&2; exit 1; }

# ─── Source distro paths written by install-packages.sh ──────────────────────
DISTRO_ENV=/etc/eventagg-distro.env
[ -f "$DISTRO_ENV" ] || err "$DISTRO_ENV not found."
. "$DISTRO_ENV"

log "Running on: $DISTRO_ID (family: $DISTRO_FAMILY)"
log "PostgreSQL binaries: $PG_BIN"

# ─── Required env vars ────────────────────────────────────────────────────────
: "${PGDATABASE:?PGDATABASE must be set}"
: "${PGUSER:?PGUSER must be set}"
: "${PGPASSWORD:?PGPASSWORD must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
PGPORT="${PGPORT:-5432}"

# Save app-level vars before any manipulation
APP_PGDATABASE="$PGDATABASE"
APP_PGUSER="$PGUSER"
APP_PGPASSWORD="$PGPASSWORD"

PG_CTL="$PG_BIN/pg_ctl"
PG_INITDB="$PG_BIN/initdb"
PG_DATA="/var/lib/postgresql/data"
PG_CONFIG="$PG_DATA/postgresql.conf"
PG_HBA="$PG_DATA/pg_hba.conf"

# ─── Locate supervisor config ──────────────────────────────────────────────────
find_supervisord_conf() {
  for c in \
      /etc/supervisor/conf.d/supervisord.conf \
      /etc/supervisord.conf \
      /etc/supervisor/supervisord.conf \
      /usr/local/etc/supervisord.conf; do
    [ -f "$c" ] && echo "$c" && return
  done
  err "Could not find supervisord.conf"
}
SUPERVISORD_CONF=$(find_supervisord_conf)
SUPERVISORD_BIN=$(command -v supervisord 2>/dev/null || err "supervisord not found")

# ─── Locate gosu ──────────────────────────────────────────────────────────────
GOSU=""
for cmd in gosu su-exec; do
  command -v "$cmd" &>/dev/null && GOSU="$cmd" && break
done

# ─── pg_admin: run SQL as postgres superuser ──────────────────────────────────
# Uses 127.0.0.1 (not localhost) to force IPv4 and avoid env var interference.
# All PG* env vars are explicitly cleared for this call.
pg_admin() {
  local sql="$1"
  local cmd="PGPASSWORD='${POSTGRES_PASSWORD}' \
    PGHOST='' PGDATABASE='' PGUSER='' PGPORT='' PGPASSWORD='${POSTGRES_PASSWORD}' \
    ${PG_BIN}/psql \
      -h 127.0.0.1 \
      -p ${PGPORT} \
      -U postgres \
      -d postgres \
      -tAc \"${sql}\""

  if [ -n "$GOSU" ]; then
    $GOSU postgres bash -c "$cmd"
  else
    su -s /bin/bash postgres -c "$cmd"
  fi
}

# ─── pg_ctl wrapper ───────────────────────────────────────────────────────────
pg_ctl_run() {
  if [ -n "$GOSU" ]; then
    $GOSU postgres "$PG_CTL" "$@"
  else
    su -s /bin/bash postgres -c "$PG_CTL $*"
  fi
}

# =============================================================================
# 1. Initialise data directory
# =============================================================================
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
  log "Initialising PostgreSQL data directory..."
  chown -R postgres:postgres "$PG_DATA"
  # Write password to a temp file owned by postgres (stdin not available in rootless)
  pwfile=$(mktemp /tmp/pgpw.XXXXXX)
  echo "$POSTGRES_PASSWORD" > "$pwfile"
  chown postgres:postgres "$pwfile"
  chmod 600 "$pwfile"
  if [ -n "$GOSU" ]; then
    $GOSU postgres "$PG_INITDB" --pgdata="$PG_DATA" --auth=md5 \
      --username=postgres --pwfile="$pwfile"
  else
    su -s /bin/bash postgres -c \
      "$PG_INITDB --pgdata=$PG_DATA --auth=md5 --username=postgres --pwfile=$pwfile"
  fi
  rm -f "$pwfile"
  log "Data directory initialised."
else
  log "Data directory already initialised -skipping initdb."
fi

# =============================================================================
# 2. Configure PostgreSQL
# =============================================================================
log "Configuring PostgreSQL..."

grep -q "^listen_addresses" "$PG_CONFIG" 2>/dev/null \
  && sed -i "s/^listen_addresses\s*=.*/listen_addresses = '*'/" "$PG_CONFIG" \
  || echo "listen_addresses = '*'" >> "$PG_CONFIG"

grep -q "^port" "$PG_CONFIG" 2>/dev/null \
  && sed -i "s/^port\s*=.*/port = $PGPORT/" "$PG_CONFIG" \
  || echo "port = $PGPORT" >> "$PG_CONFIG"

grep -q "# EventAgg" "$PG_CONFIG" 2>/dev/null || cat >> "$PG_CONFIG" <<EOF

# EventAgg -added by entrypoint
wal_level = replica
max_wal_senders = 3
EOF

cat > "$PG_HBA" <<EOF
# TYPE  DATABASE  USER      ADDRESS         METHOD
local   all       postgres                  trust
local   all       all                       md5
host    all       all       127.0.0.1/32    md5
host    all       all       0.0.0.0/0       md5
host    all       all       ::1/128         md5
host    all       all       ::/0            md5
EOF

chown postgres:postgres "$PG_CONFIG" "$PG_HBA"
log "PostgreSQL configured."

# =============================================================================
# 3. Start PostgreSQL temporarily
# =============================================================================
log "Starting PostgreSQL for initialisation..."
mkdir -p /var/log/supervisor && chmod 1777 /var/log/supervisor

pg_ctl_run start --pgdata="$PG_DATA" --wait --timeout=60 \
  --log="$PG_DATA/postgres-init.log"

# Wait for it to accept connections on 127.0.0.1 explicitly
for i in $(seq 1 30); do
  if PGPASSWORD="$POSTGRES_PASSWORD" "${PG_BIN}/psql" \
      -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "SELECT 1" \
      &>/dev/null; then
    log "PostgreSQL is ready."
    break
  fi
  [ "$i" -eq 30 ] && err "PostgreSQL did not become ready."
  sleep 1
done

# =============================================================================
# 4. Create application user
# =============================================================================
log "Checking database user '$APP_PGUSER'..."
USER_EXISTS=$(pg_admin "SELECT 1 FROM pg_roles WHERE rolname='${APP_PGUSER}';" | tr -d '[:space:]')

if [ "$USER_EXISTS" = "1" ]; then
  warn "User '$APP_PGUSER' exists -updating password."
  pg_admin "ALTER USER ${APP_PGUSER} WITH PASSWORD '${APP_PGPASSWORD}';"
else
  log "Creating user '$APP_PGUSER'..."
  pg_admin "CREATE USER ${APP_PGUSER} WITH PASSWORD '${APP_PGPASSWORD}' CREATEDB;"
  log "User '$APP_PGUSER' created."
fi

# =============================================================================
# 5. Create application database
# =============================================================================
log "Checking database '$APP_PGDATABASE'..."
DB_EXISTS=$(pg_admin "SELECT 1 FROM pg_database WHERE datname='${APP_PGDATABASE}';" | tr -d '[:space:]')

if [ "$DB_EXISTS" = "1" ]; then
  warn "Database '$APP_PGDATABASE' already exists -skipping."
else
  log "Creating database '$APP_PGDATABASE'..."
  pg_admin "CREATE DATABASE ${APP_PGDATABASE} OWNER ${APP_PGUSER};"
  log "Database '$APP_PGDATABASE' created."
fi

pg_admin "GRANT ALL PRIVILEGES ON DATABASE ${APP_PGDATABASE} TO ${APP_PGUSER};"

# =============================================================================
# 6. Run migrations
# =============================================================================
log "Running database migrations..."
PGHOST=127.0.0.1 \
PGPORT="$PGPORT" \
PGDATABASE="$APP_PGDATABASE" \
PGUSER="$APP_PGUSER" \
PGPASSWORD="$APP_PGPASSWORD" \
  node /app/backend/dist/db/migrate.js
log "Migrations complete."

# =============================================================================
# 7. Stop temporary Postgres
# =============================================================================
log "Stopping temporary PostgreSQL..."
pg_ctl_run stop --pgdata="$PG_DATA" --wait --mode=fast
log "Stopped."

# =============================================================================
# 8. Patch supervisord.conf with correct PG_BIN
# =============================================================================
sed -i "s|__PG_BIN__|${PG_BIN}|g" "$SUPERVISORD_CONF"
log "supervisord.conf updated (PG_BIN=${PG_BIN})"

# =============================================================================
# 9. Hand off to supervisord
# =============================================================================
log "Starting all services..."
log "  → PostgreSQL     :${PGPORT}"
log "  → Backend API    :3001"
log "  → Frontend       :80 (mapped to ${HOST_PORT:-9090} on host)"
log ""
log "  Postgres: postgresql://${APP_PGUSER}:***@<host>:${PGPORT}/${APP_PGDATABASE}"
log ""

exec "$SUPERVISORD_BIN" -c "$SUPERVISORD_CONF"
