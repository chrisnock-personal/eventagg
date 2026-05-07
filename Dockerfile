# ARG must be declared before all FROM statements for Buildah/Podman compatibility
ARG BASE_IMAGE=ubuntu:22.04

# =============================================================================
# Stage 1 — Build the frontend (React → static files)
# =============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/index.html ./
COPY frontend/vite.config.ts ./
COPY frontend/tsconfig.json ./
COPY frontend/tsconfig.node.json ./
COPY frontend/src ./src

RUN npm run build


# =============================================================================
# Stage 2 — Build the backend (TypeScript → JavaScript)
# =============================================================================
FROM node:20-alpine AS backend-builder

WORKDIR /build/backend

COPY backend/package*.json ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src

RUN npm run build

# Copy SQL migration files into dist (tsc does not copy non-TS files)
RUN cp -r src/migrations dist/migrations

# Production-only node_modules
RUN npm install --omit=dev


# =============================================================================
# Stage 3 — Runtime image
#
# Override BASE_IMAGE at build time:
#   podman-compose build --build-arg BASE_IMAGE=fedora:40
#   podman-compose build --build-arg BASE_IMAGE=rockylinux:9
#   podman-compose build --build-arg BASE_IMAGE=debian:12
# =============================================================================
FROM ${BASE_IMAGE} AS production

ENV TZ=UTC \
    NODE_ENV=production \
    PGHOST=localhost \
    PGPORT=5432 \
    PGDATABASE=eventagg \
    PGUSER=eventagg_user \
    PGPASSWORD=eventagg_pass \
    POSTGRES_PASSWORD=postgres_admin_pass

# ── Install all system packages via the distro-aware script ───────────────────
COPY install-packages.sh /tmp/install-packages.sh
RUN chmod +x /tmp/install-packages.sh \
    && /tmp/install-packages.sh \
    && rm /tmp/install-packages.sh

# ── Create application user ────────────────────────────────────────────────────
RUN useradd --system --no-create-home --shell /bin/false eventagg 2>/dev/null \
    || adduser --system --no-create-home --shell /bin/false eventagg 2>/dev/null \
    || true

# ── Create required directories ────────────────────────────────────────────────
RUN mkdir -p \
    /var/log/supervisor \
    /var/log/nginx \
    /var/lib/postgresql/data \
    && chmod 1777 /var/log/supervisor \
    && chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true

# ── Copy compiled artefacts ────────────────────────────────────────────────────
COPY --from=frontend-builder /build/frontend/dist         /app/frontend/dist
COPY --from=backend-builder  /build/backend/dist          /app/backend/dist
COPY --from=backend-builder  /build/backend/dist/migrations /app/backend/dist/migrations
COPY --from=backend-builder  /build/backend/node_modules  /app/backend/node_modules

# ── Copy configuration ────────────────────────────────────────────────────────
COPY nginx.conf       /etc/nginx/sites-available/eventagg
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Wire up nginx site ────────────────────────────────────────────────────────
RUN mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled \
    && rm -f /etc/nginx/sites-enabled/default \
             /etc/nginx/conf.d/default.conf \
    && ln -sf /etc/nginx/sites-available/eventagg \
              /etc/nginx/sites-enabled/eventagg \
    && NGINX_CONF=/etc/nginx/nginx.conf \
    && grep -q "sites-enabled" "$NGINX_CONF" \
       || sed -i '/http {/a\    include /etc/nginx/sites-enabled/*;' "$NGINX_CONF"

EXPOSE 80 3001 5432

VOLUME ["/var/lib/postgresql/data"]

ENTRYPOINT ["/entrypoint.sh"]
