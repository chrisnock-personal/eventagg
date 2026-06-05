#!/usr/bin/env bash
# ─── Aggre/Gator Sync & Deploy Script ────────────────────────────────────────
# Syncs local source changes to the remote server and optionally rebuilds.
#
# Usage:
#   ./sync.sh [user@ip]          # sync + rebuild + restart
#   ./sync.sh --sync-only        # sync files only, no rebuild
#   ./sync.sh --rebuild-only     # rebuild without syncing
#   ./sync.sh --logs             # tail logs after deploy

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
REMOTE_HOST="${AGGRE_REMOTE:-chris@192.168.1.135}"
REMOTE_DIR="${AGGRE_REMOTE_DIR:-~/Apps/open-event-aggregator/eventagg}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Arg parsing ─────────────────────────────────────────────────────────────
SYNC_ONLY=false
REBUILD_ONLY=false
SHOW_LOGS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --sync-only)    SYNC_ONLY=true ;;
    --rebuild-only) REBUILD_ONLY=true ;;
    --logs)         SHOW_LOGS=true ;;
    --help|-h)
      echo "Usage: ./sync.sh [user@ip] [options]"
      echo ""
      echo "  user@ip            Remote host to deploy to (default: $REMOTE_HOST)"
      echo "  --sync-only        Sync files only, skip rebuild"
      echo "  --rebuild-only     Rebuild on remote without syncing"
      echo "  --logs             Tail backend logs after deploy"
      echo ""
      echo "  Set AGGRE_REMOTE=user@host to change default remote"
      echo "  Set AGGRE_REMOTE_DIR=path  to change remote path"
      exit 0
      ;;
    *@*)            REMOTE_HOST="$1" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

echo "🐊  Aggre/Gator Sync & Deploy"
echo "    Local:  $LOCAL_DIR"
echo "    Remote: $REMOTE_HOST:$REMOTE_DIR"
echo ""

# ─── Sync ─────────────────────────────────────────────────────────────────────
if [ "$REBUILD_ONLY" = false ]; then
  echo "📦  Syncing source files..."

  rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude '.env' \
    --filter=':- .gitignore' \
    "$LOCAL_DIR/" \
    "$REMOTE_HOST:$REMOTE_DIR/"

  echo "✓  Sync complete"
  echo ""
fi

# ─── Rebuild ──────────────────────────────────────────────────────────────────
if [ "$SYNC_ONLY" = false ]; then
  echo "🔨  Building and restarting on $REMOTE_HOST..."
  echo ""

  ssh "$REMOTE_HOST" bash << EOF
    set -e
    cd $REMOTE_DIR

    echo "→ Stopping container..."
    podman-compose down 2>/dev/null || true

    echo "→ Removing old image..."
    podman rmi localhost/eventagg_eventagg:latest 2>/dev/null || true

    echo "→ Building new image..."
    podman build --no-cache --layers=false -t localhost/eventagg_eventagg:latest .

    echo "→ Starting container..."
    podman-compose up -d

    echo ""
    echo "→ Waiting for startup..."
    sleep 5

    echo ""
    echo "─── Startup logs ────────────────────────────────────────────────"
    podman exec eventagg supervisorctl tail backend 2>/dev/null | tail -20 || podman logs eventagg 2>&1 | tail -20
    echo "─────────────────────────────────────────────────────────────────"
    echo ""
    echo "✅  Deploy complete"
    echo "    UI:   http://\$(hostname -I | awk '{print \$1}'):8080"
    echo "    API:  http://\$(hostname -I | awk '{print \$1}'):3001"
    echo "    SNMP: \$(hostname -I | awk '{print \$1}'):1162/udp"
EOF

  echo ""
fi

# ─── Logs ─────────────────────────────────────────────────────────────────────
if [ "$SHOW_LOGS" = true ]; then
  echo "📋  Tailing backend logs (Ctrl+C to stop)..."
  echo ""
  ssh -t "$REMOTE_HOST" "podman exec eventagg supervisorctl tail -f backend"
fi
