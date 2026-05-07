#!/usr/bin/env bash
# =============================================================================
# install-packages.sh
# Detects the Linux distribution and installs:
#   - PostgreSQL 16
#   - Node.js 20
#   - nginx
#   - supervisor
#   - gosu (or su-exec on Alpine-family)
#   - curl, ca-certificates, and other utilities
#
# Supported families:
#   apt   → Ubuntu 22.04/24.04, Debian 11/12
#   dnf   → Fedora 39/40, RHEL/Rocky/AlmaLinux 8/9, Amazon Linux 2023
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
err()  { echo -e "${RED}[install]${NC} $*" >&2; exit 1; }

# ── Detect distro ──────────────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_ID_LIKE="${ID_LIKE:-}"
  DISTRO_VERSION_ID="${VERSION_ID:-0}"
else
  err "/etc/os-release not found — cannot detect distribution."
fi

log "Detected: ${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION_ID}"

# ── Resolve distro family ──────────────────────────────────────────────────────
# Returns 'apt', 'dnf', or errors
detect_family() {
  case "$DISTRO_ID" in
    ubuntu|debian|linuxmint|pop)
      echo "apt" ;;
    fedora)
      echo "dnf" ;;
    rhel|centos|rocky|almalinux|ol)
      echo "dnf" ;;
    amzn)
      # Amazon Linux 2023 uses dnf; Amazon Linux 2 uses yum (not supported here)
      if [ "${DISTRO_VERSION_ID%%.*}" -ge 2023 ] 2>/dev/null; then
        echo "dnf"
      else
        err "Amazon Linux 2 is not supported. Please use Amazon Linux 2023 or later."
      fi ;;
    *)
      # Check ID_LIKE for derivatives
      for like in $DISTRO_ID_LIKE; do
        case "$like" in
          debian|ubuntu) echo "apt"; return ;;
          rhel|fedora)   echo "dnf"; return ;;
        esac
      done
      err "Unsupported distribution: $DISTRO_ID. Supported: Ubuntu, Debian, Fedora, RHEL/Rocky/AlmaLinux, Amazon Linux 2023."
      ;;
  esac
}

FAMILY=$(detect_family)
log "Package manager family: $FAMILY"

# =============================================================================
# APT family — Ubuntu / Debian
# =============================================================================
install_apt() {
  export DEBIAN_FRONTEND=noninteractive

  log "Updating apt package index..."
  apt-get update -qq

  log "Installing prerequisites..."
  apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    lsb-release \
    ca-certificates \
    sudo

  # ── PostgreSQL 16 via PGDG ───────────────────────────────────────────────
  log "Adding PostgreSQL 16 apt repository..."
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] \
    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-client-16

  # ── Node.js 20 via NodeSource ────────────────────────────────────────────
  log "Adding Node.js 20 apt repository..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs

  # ── nginx, supervisor, gosu ──────────────────────────────────────────────
  log "Installing nginx, supervisor, gosu..."
  apt-get install -y --no-install-recommends \
    nginx \
    supervisor \
    gosu

  # ── Clean up ─────────────────────────────────────────────────────────────
  apt-get clean
  rm -rf /var/lib/apt/lists/*

  log "apt installation complete."
}

# =============================================================================
# DNF family — Fedora / RHEL / Rocky / AlmaLinux / Amazon Linux 2023
# =============================================================================
install_dnf() {
  # Determine if we need EPEL and/or CRB (Rocky/RHEL/Alma)
  MAJOR_VER="${DISTRO_VERSION_ID%%.*}"
  IS_RHEL_FAMILY=false
  IS_FEDORA=false
  IS_AMAZON=false

  case "$DISTRO_ID" in
    fedora) IS_FEDORA=true ;;
    amzn)   IS_AMAZON=true ;;
    rhel|centos|rocky|almalinux|ol) IS_RHEL_FAMILY=true ;;
  esac

  log "Updating dnf package index..."
  dnf -y -q update

  log "Installing prerequisites..."
  dnf -y -q install \
    curl \
    ca-certificates \
    gnupg2 \
    findutils \
    sudo

  # ── EPEL + CRB for RHEL-family (provides supervisor, gosu etc.) ──────────
  if [ "$IS_RHEL_FAMILY" = true ]; then
    log "Enabling EPEL and CRB repositories..."
    dnf -y -q install epel-release || true
    # CRB (CodeReady Builder) — name varies by distro
    if dnf config-manager --set-enabled crb 2>/dev/null; then
      log "CRB enabled via config-manager."
    elif dnf config-manager --set-enabled powertools 2>/dev/null; then
      log "PowerTools (CRB) enabled via config-manager."
    else
      warn "Could not enable CRB/PowerTools — some packages may be unavailable."
    fi
    dnf -y -q update
  fi

  # ── PostgreSQL 16 via PGDG ───────────────────────────────────────────────
  log "Adding PostgreSQL 16 dnf repository..."
  if [ "$IS_FEDORA" = true ]; then
    # Fedora ships its own postgres but PGDG gives us pg16 specifically
    PGDG_RPM="https://download.postgresql.org/pub/repos/yum/reporpms/F-${MAJOR_VER}-x86_64/pgdg-fedora-repo-latest.noarch.rpm"
  elif [ "$IS_AMAZON" = true ]; then
    PGDG_RPM="https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
  else
    PGDG_RPM="https://download.postgresql.org/pub/repos/yum/reporpms/EL-${MAJOR_VER}-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
  fi

  dnf -y -q install "$PGDG_RPM" || warn "PGDG RPM install failed — trying direct package name."

  # Disable the distro's built-in postgres module if present (RHEL 8+)
  dnf -y -q module disable postgresql 2>/dev/null || true

  dnf -y -q install \
    postgresql16-server \
    postgresql16

  # ── Node.js 20 via NodeSource ────────────────────────────────────────────
  log "Adding Node.js 20 dnf repository..."
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf -y -q install nodejs

  # ── nginx ────────────────────────────────────────────────────────────────
  log "Installing nginx..."
  dnf -y -q install nginx

  # ── supervisor ───────────────────────────────────────────────────────────
  log "Installing supervisor..."
  # Available in EPEL on RHEL-family; in default repos on Fedora/Amazon
  dnf -y -q install supervisor || {
    warn "supervisor not found in repos — installing via pip..."
    dnf -y -q install python3-pip
    pip3 install --quiet supervisor
  }

  # ── gosu — not in RHEL-family repos, build from GitHub binary ────────────
  log "Installing gosu..."
  GOSU_VERSION="1.17"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  GOSU_ARCH="amd64" ;;
    aarch64) GOSU_ARCH="arm64" ;;
    *)       err "Unsupported architecture for gosu: $ARCH" ;;
  esac
  curl -fsSL "https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${GOSU_ARCH}" \
    -o /usr/local/bin/gosu
  chmod +x /usr/local/bin/gosu
  # Verify
  gosu nobody true

  # ── Clean up ─────────────────────────────────────────────────────────────
  dnf clean all

  log "dnf installation complete."
}

# =============================================================================
# Dispatch
# =============================================================================
case "$FAMILY" in
  apt) install_apt ;;
  dnf) install_dnf ;;
  *)   err "Unknown family: $FAMILY" ;;
esac

# =============================================================================
# Post-install: locate pg_ctl and write a env file the entrypoint sources
# =============================================================================
log "Locating PostgreSQL 16 binaries..."

PG_BIN=""
for candidate in \
    /usr/lib/postgresql/16/bin \
    /usr/pgsql-16/bin \
    /usr/local/pgsql/bin; do
  if [ -x "${candidate}/pg_ctl" ]; then
    PG_BIN="$candidate"
    break
  fi
done

if [ -z "$PG_BIN" ]; then
  err "Could not locate pg_ctl. PostgreSQL 16 may not have installed correctly."
fi

log "PostgreSQL binaries found at: $PG_BIN"

# Write distro-specific paths to a file the entrypoint sources at runtime
cat > /etc/eventagg-distro.env <<EOF
# Auto-generated by install-packages.sh — do not edit
DISTRO_FAMILY=$FAMILY
DISTRO_ID=$DISTRO_ID
PG_BIN=$PG_BIN
EOF

log "Wrote /etc/eventagg-distro.env"
log "Package installation complete."
