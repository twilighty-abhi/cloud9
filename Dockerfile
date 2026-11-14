# Cloud 9 — production image
# Debian slim (glibc) rather than alpine: better-sqlite3 ships prebuilt glibc binaries.
# Base image pinned by digest (multi-arch index of node:22.23.4-bookworm-slim, published 2026-11-05) so rebuilds and
# rollbacks get the same runtime. To update: pick a newer node:22.x.y-bookworm-slim tag and replace tag + digest
# (docker buildx imagetools inspect node:22.x.y-bookworm-slim → top-level Digest).

# ───────────── builder ─────────────
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS builder
WORKDIR /app

# Toolchain only used if better-sqlite3 has to compile from source (prebuilt download failed).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ───────────── runtime ─────────────
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cloud9.db \
    WEB_DIST=/app/dist/web

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--max-old-space-size=1536", "dist/server.mjs"]
