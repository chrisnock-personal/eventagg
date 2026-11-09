#!/usr/bin/env bash
# =============================================================================
# eventagg-tls: the HTTPS certificate nginx serves (/app/certs, `certs` volume)
#
#   eventagg-tls ensure   Called by entrypoint.sh on every start. Generates a
#                         self-signed certificate if there's none, and
#                         regenerates a self-signed one whose host names/IPs
#                         no longer match (e.g. the host's DHCP address
#                         changed). An uploaded certificate is never touched.
#   eventagg-tls watch    Long-running (supervisord, as root). Applies what
#                         the backend stages in /app/certs/staged/:
#                           server.crt + server.key  -> install an uploaded cert
#                           regenerate               -> back to self-signed
#                         Each change is checked with `nginx -t` and reloaded;
#                         on any failure the previous certificate is put back.
#                         The outcome goes to /app/certs/status.json, which
#                         the Settings -> TLS page polls.
#
# The backend (user eventagg) can only write to staged/ and never touches the
# live key; this script, as root, is the only thing that installs one.
# =============================================================================
set -uo pipefail

CERT_DIR=/app/certs
STAGED="$CERT_DIR/staged"
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"
SELF_MARK="$CERT_DIR/selfsigned.sans"   # present = current cert is self-signed
STATUS="$CERT_DIR/status.json"

log() { echo "[eventagg-tls] $*"; }

# DNS names and IPs this host answers on: the container shares the host's
# network (network_mode: host), so these are the host's own.
current_sans() {
  node -e '
    const os = require("os");
    const names = new Set(["localhost", os.hostname()]);
    const ips = new Set(["127.0.0.1", "::1"]);
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list || []) if (!a.internal && !a.address.startsWith("fe80")) ips.add(a.address);
    const extra = (process.env.TLS_SANS || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const e of extra) (/^[0-9.:]+$/.test(e) ? ips : names).add(e);
    process.stdout.write([...[...names].sort().map(n => "DNS:" + n), ...[...ips].sort().map(i => "IP:" + i)].join(","));'
}

write_status() { # ok message
  local fp=""
  [ -f "$CRT" ] && fp=$(openssl x509 -in "$CRT" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  node -e 'const [ok, message, fp] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ ok: ok === "true", message, fingerprint: fp, at: new Date().toISOString() }))' \
    "$1" "$2" "$fp" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  chmod 644 "$STATUS"
}

generate_self_signed() {
  local sans; sans=$(current_sans)
  local tmp; tmp=$(mktemp -d)
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -days 3650 -subj "/CN=$(hostname)/O=Aggre-Gator self-signed" \
    -addext "subjectAltName=$sans" -addext "basicConstraints=critical,CA:FALSE" \
    -addext "extendedKeyUsage=serverAuth" \
    -keyout "$tmp/server.key" -out "$tmp/server.crt" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  install -m 644 -o root -g root "$tmp/server.crt" "$CRT"
  install -m 600 -o root -g root "$tmp/server.key" "$KEY"
  printf '%s' "$sans" > "$SELF_MARK"
  rm -rf "$tmp"
  log "Generated a self-signed certificate for $sans"
}

prepare_dirs() {
  mkdir -p "$CERT_DIR" "$STAGED"
  local grp; grp=$(id -gn eventagg)
  chown "root:$grp" "$CERT_DIR" && chmod 750 "$CERT_DIR"
  chown "eventagg:$grp" "$STAGED" && chmod 700 "$STAGED"
}

ensure() {
  prepare_dirs
  if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
    generate_self_signed || { log "ERROR: could not generate a certificate"; exit 1; }
    write_status true "Self-signed certificate generated"
  elif [ -f "$SELF_MARK" ] && [ "$(cat "$SELF_MARK")" != "$(current_sans)" ]; then
    log "Host names/addresses changed -regenerating the self-signed certificate"
    generate_self_signed && write_status true "Self-signed certificate regenerated for new host addresses"
  fi
  [ -f "$STATUS" ] || write_status true "Certificate in place"
  chmod 644 "$CRT"; chmod 600 "$KEY"
}

reload_nginx() {
  nginx -t >/dev/null 2>&1 || return 1
  nginx -s reload >/dev/null 2>&1
}

apply_staged() {
  local prev; prev=$(mktemp -d)
  cp -p "$CRT" "$KEY" "$prev/" 2>/dev/null
  [ -f "$SELF_MARK" ] && cp -p "$SELF_MARK" "$prev/"

  local action msg
  if [ -f "$STAGED/regenerate" ]; then
    action="regenerate"
    rm -f "$STAGED/regenerate"
    generate_self_signed; msg="Self-signed certificate regenerated"
  else
    action="upload"
    install -m 644 -o root -g root "$STAGED/server.crt" "$CRT"
    install -m 600 -o root -g root "$STAGED/server.key" "$KEY"
    rm -f "$SELF_MARK"
    msg="Uploaded certificate installed"
  fi
  rm -f "$STAGED/server.crt" "$STAGED/server.key"

  if reload_nginx; then
    write_status true "$msg"
    log "$msg"
  else
    # Put the previous certificate back and reload that.
    cp -p "$prev/server.crt" "$CRT"; cp -p "$prev/server.key" "$KEY"
    if [ -f "$prev/selfsigned.sans" ]; then cp -p "$prev/selfsigned.sans" "$SELF_MARK"; else rm -f "$SELF_MARK"; fi
    reload_nginx
    write_status false "nginx rejected the new certificate ($action); the previous one is still in use"
    log "nginx rejected the new certificate -rolled back"
  fi
  rm -rf "$prev"
}

watch() {
  prepare_dirs
  while true; do
    if [ -f "$STAGED/regenerate" ] || { [ -f "$STAGED/server.crt" ] && [ -f "$STAGED/server.key" ] && [ -f "$STAGED/ready" ]; }; then
      rm -f "$STAGED/ready"
      apply_staged
    fi
    sleep 2
  done
}

case "${1:-}" in
  ensure) ensure ;;
  watch)  watch ;;
  *) echo "Usage: $0 {ensure|watch}" >&2; exit 2 ;;
esac
