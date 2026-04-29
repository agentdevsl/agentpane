# Production Dockerfile for AgentPane
#
# Multi-stage build: deps → build → runtime
#
# Usage:
#   docker build -f docker/Dockerfile -t agentpane:latest .
#   docker run -p 3000:3000 -v agentpane-data:/app/data agentpane:latest

# ─── Stage 1: Install dependencies ───
FROM oven/bun:1.3.10-alpine AS deps

WORKDIR /app

# F11-15: a single lockfile per workspace. agent-runner uses bun.lock — npm
# is no longer used to install agent-runner deps.
COPY package.json bun.lock* ./
COPY agent-runner/package.json agent-runner/bun.lock ./agent-runner/

RUN bun install --frozen-lockfile --production=false
RUN cd agent-runner && bun install --frozen-lockfile --production=false

# ─── Stage 2: Build application ───
FROM oven/bun:1.3.10-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/agent-runner/node_modules ./agent-runner/node_modules
COPY . .

# Build frontend + typecheck + agent runner
RUN bun run build

# ─── Download durable-streams-server (Caddy with durable-streams plugin) ───
FROM alpine:3.21 AS caddy
ARG TARGETARCH
RUN test -n "$TARGETARCH" || (echo "ERROR: TARGETARCH is not set. Use docker buildx or set --build-arg TARGETARCH=amd64" && exit 1)
ADD https://github.com/anthropics/durable-streams/releases/download/v0.2.1/durable-streams-server_linux_${TARGETARCH} /usr/local/bin/durable-streams-server
RUN chmod +x /usr/local/bin/durable-streams-server

# ─── Stage 3: Production runtime ───
FROM oven/bun:1.3.10-alpine AS runtime

RUN apk add --no-cache git tini wget bash

WORKDIR /app

# Copy durable-streams-server (Caddy) binary
COPY --from=caddy /usr/local/bin/durable-streams-server /usr/local/bin/durable-streams-server

# Copy built assets and production deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/agent-runner/dist ./agent-runner/dist
COPY --from=build /app/agent-runner/package.json ./agent-runner/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
# F11-17: scripts/migrate-check-only.ts is invoked by start.sh on boot, and
# scripts/migrate-run-only.ts is the entrypoint for the Helm pre-upgrade Job.
COPY --from=build /app/scripts ./scripts

# Copy Caddyfile and start script
COPY Caddyfile /app/Caddyfile
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create data directory for SQLite and streams
RUN mkdir -p /app/data /app/streams && chown -R bun:bun /app/data /app/streams

# Non-root user
USER bun

# Expose Caddy front door port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]

ENV NODE_ENV=production
ENV DB_PATH=/app/data/agentpane.db

CMD ["/app/start.sh"]
