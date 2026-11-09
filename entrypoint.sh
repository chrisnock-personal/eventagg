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
PGPORT="${PGPORT:-5432}"

# ─── Database passwords ───────────────────────────────────────────────────────
# No fixed defaults. An explicit env var wins; otherwise a random password is
# generated on first boot into the `secrets` volume and reused after that.
# Sections 3 and 4 apply them to the roles on every boot, so changing either
# (or deleting its file) is a rotation. Hex only, so they're safe inside the
# SQL string literals below.
mkdir -p /app/secrets
chmod 700 /app/secrets
load_or_generate_secret() {
  local var="$1" file="$2"
  if [ -z "${!var:-}" ]; then
    if [ ! -s "$file" ]; then
      log "No $var set -generating one in $file (persisted from now on)..."
      node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > "$file"
    fi
    chmod 600 "$file"
    printf -v "$var" '%s' "$(cat "$file")"
  fi
  export "${var?}"
}
load_or_generate_secret PGPASSWORD        /app/secrets/pg_app.pass
load_or_generate_secret POSTGRES_PASSWORD /app/secrets/pg_super.pass

# So `podman exec eventagg psql ...` (run as root, as the runbooks do) still
# authenticates: a generated password isn't in the container's configured
# env, only in this process tree. libpq treats the empty PGPASSWORD that
# docker-compose sets as unset, so it falls through to this file.
umask 077
cat > /root/.pgpass <<PGPASS
*:*:*:${PGUSER}:${PGPASSWORD}
*:*:*:postgres:${POSTGRES_PASSWORD}
PGPASS
umask 022

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
    $GOSU postgres "$PG_INITDB" --pgdata="$PG_DATA" --auth=scram-sha-256 \
      --username=postgres --pwfile="$pwfile"
  else
    su -s /bin/bash postgres -c \
      "$PG_INITDB --pgdata=$PG_DATA --auth=scram-sha-256 --username=postgres --pwfile=$pwfile"
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

# Loopback only. The container uses host networking, so '*' put Postgres on
# the LAN. The backend and the runbooks' `podman exec ... psql` all connect
# locally; from another machine, use an SSH tunnel.
grep -q "^listen_addresses" "$PG_CONFIG" 2>/dev/null \
  && sed -i "s/^listen_addresses\s*=.*/listen_addresses = 'localhost'/" "$PG_CONFIG" \
  || echo "listen_addresses = 'localhost'" >> "$PG_CONFIG"

grep -q "^password_encryption" "$PG_CONFIG" 2>/dev/null \
  && sed -i "s/^password_encryption\s*=.*/password_encryption = 'scram-sha-256'/" "$PG_CONFIG" \
  || echo "password_encryption = 'scram-sha-256'" >> "$PG_CONFIG"

grep -q "^port" "$PG_CONFIG" 2>/dev/null \
  && sed -i "s/^port\s*=.*/port = $PGPORT/" "$PG_CONFIG" \
  || echo "port = $PGPORT" >> "$PG_CONFIG"

grep -q "# EventAgg" "$PG_CONFIG" 2>/dev/null || cat >> "$PG_CONFIG" <<EOF

# EventAgg -added by entrypoint
wal_level = replica
max_wal_senders = 3
EOF

# scram-sha-256, loopback only. The postgres OS user keeps trust on the
# socket: that's how section 3 sets the superuser password (and rehashes an
# old md5 hash) without needing to know the current one.
cat > "$PG_HBA" <<EOF
# TYPE  DATABASE  USER      ADDRESS         METHOD
local   all       postgres                  trust
local   all       all                       scram-sha-256
host    all       all       127.0.0.1/32    scram-sha-256
host    all       all       ::1/128         scram-sha-256
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

# Apply the superuser password over the socket (trust for the postgres OS
# user) before anything authenticates over TCP. This rehashes a pre-scram md5
# hash, and takes over a data directory whose superuser password was the old
# fixed default or has been lost along with the secrets volume.
# The container's PGHOST/PGUSER/... would otherwise send this over TCP as
# the app user, so clear them and name the socket's user and port.
pg_super_sql="ALTER USER postgres WITH PASSWORD '${POSTGRES_PASSWORD}';"
pg_socket_psql=(env -u PGHOST -u PGHOSTADDR -u PGUSER -u PGPASSWORD -u PGDATABASE -u PGPORT
  "${PG_BIN}/psql" -U postgres -p "$PGPORT" -d postgres -qtAc "$pg_super_sql")
if [ -n "$GOSU" ]; then
  $GOSU postgres "${pg_socket_psql[@]}"
else
  su -s /bin/bash postgres -c "$(printf '%q ' "${pg_socket_psql[@]}")"
fi
unset pg_super_sql pg_socket_psql

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
# 7b. JWT signing secret
# =============================================================================
# Generate once, persist in the `secrets` volume, reuse forever after, so
# sessions survive restarts and container recreates without anyone having to
# set JWT_SECRET (middleware/session.ts resolveJwtSecrets()). An explicit
# JWT_SECRET env var always wins. Same shape as Alfoir's credential/JWT keys.
JWT_KEY_FILE=/app/secrets/jwt.key
if [ -z "${JWT_SECRET:-}" ] && [ ! -s "$JWT_KEY_FILE" ]; then
  log "No JWT_SECRET set and no persisted key -generating one in $JWT_KEY_FILE (persisted from now on)..."
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$JWT_KEY_FILE"
fi
[ -f "$JWT_KEY_FILE" ] && chown eventagg "$JWT_KEY_FILE" && chmod 600 "$JWT_KEY_FILE"

# =============================================================================
# 7c. Data encryption key (stored credentials: webhook secrets, SMTP password)
# =============================================================================
# Same pattern as jwt.key: generated once, kept in the `secrets` volume (not
# in Postgres, so a database backup alone doesn't reveal those values), and
# DATA_ENCRYPTION_KEY wins if set. See services/secretBox.ts. Losing this
# file loses the stored credentials (they must be re-entered), so back up the
# secrets volume along with the database (DISASTER_RECOVERY.md).
DATA_KEY_FILE=/app/secrets/data.key
if [ -z "${DATA_ENCRYPTION_KEY:-}" ] && [ ! -s "$DATA_KEY_FILE" ]; then
  log "No DATA_ENCRYPTION_KEY set and no persisted key -generating one in $DATA_KEY_FILE (persisted from now on)..."
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$DATA_KEY_FILE"
fi
[ -f "$DATA_KEY_FILE" ] && chown eventagg "$DATA_KEY_FILE" && chmod 600 "$DATA_KEY_FILE"

# =============================================================================
# 7d. HTTPS: certificate and nginx site
# =============================================================================
# A self-signed certificate on first start (and again if the host's names or
# addresses change), unless one was uploaded in Settings -> TLS. See tls.sh.
HTTP_PORT="${HTTP_PORT:-8080}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
/usr/local/bin/eventagg-tls ensure
sed -e "s/__HTTP_PORT__/${HTTP_PORT}/g" -e "s/__HTTPS_PORT__/${HTTPS_PORT}/g" \
  /etc/nginx/eventagg.conf.template > /etc/nginx/sites-available/eventagg
nginx -t 2>&1 | grep -v "syntax is ok\|test is successful" || true
nginx -t >/dev/null 2>&1 || err "nginx configuration test failed (see above)"

# =============================================================================
# 8. Patch supervisord.conf with correct PG_BIN
# =============================================================================
sed -i "s|__PG_BIN__|${PG_BIN}|g" "$SUPERVISORD_CONF"
log "supervisord.conf updated (PG_BIN=${PG_BIN})"

# =============================================================================
# 9. Hand off to supervisord
# =============================================================================
log "Starting all services..."
log "  → PostgreSQL     127.0.0.1:${PGPORT} (loopback only)"
log "  → Backend API    ${BIND_ADDRESS:-127.0.0.1}:${PORT:-3001} (proxied by nginx at /api/)"
log "  → Frontend       https://<host>:${HTTPS_PORT} (http://<host>:${HTTP_PORT} redirects)"
log ""
log "  Postgres: postgresql://${APP_PGUSER}:***@127.0.0.1:${PGPORT}/${APP_PGDATABASE}"
log ""

exec "$SUPERVISORD_BIN" -c "$SUPERVISORD_CONF"
