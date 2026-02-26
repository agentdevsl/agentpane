# Deployment Specification

## Overview

This specification defines the deployment architecture, environment configuration, build processes, and operational procedures for AgentPane. The primary deployment model is a single-node local installation, with optional Docker containerization and cloud deployment patterns for scaling.

**Tech Stack Reference:**

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Bun | 1.3.10 |
| Framework | TanStack Start | 1.150.0 |
| Database | PGlite | 0.3.15 |
| ORM | Drizzle | 0.45.1 |
| Agent Events | Durable Streams | 0.1.5 |
| AI/Agents | Claude Agent SDK | 0.2.9 |
| Testing | Vitest | 4.0.17 |
| Linting | Biome | 2.3.11 |

**Related Specifications:**

- [App Bootstrap](../architecture/app-bootstrap.md) - Application initialization sequence
- [Database Schema](../database/schema.md) - PGlite schema and migrations
- [Configuration Management](../configuration/config-management.md) - Environment and config handling
- [Security Model](../security/security-model.md) - Secrets and credential management
- [Durable Sessions](../integrations/durable-sessions.md) - Real-time event streaming

---

## 1. Deployment Topology

### 1.1 Single-Node Local Deployment (Primary Use Case)

AgentPane is designed as a developer-first local application. The primary deployment model runs all services on a single machine.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Developer Machine                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        AgentPane Process (Bun)                          │ │
│  │                                                                         │ │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────────┐   │ │
│  │  │   TanStack    │  │   Durable     │  │    Claude Agent SDK       │   │ │
│  │  │   Start       │  │   Streams     │  │    Workers (1-6)          │   │ │
│  │  │   Server      │  │   Server      │  │                           │   │ │
│  │  │   :5173       │  │   (SSE/WS)    │  │    ┌───┐ ┌───┐ ┌───┐     │   │ │
│  │  │               │  │               │  │    │ A │ │ A │ │ A │     │   │ │
│  │  └───────────────┘  └───────────────┘  │    └───┘ └───┘ └───┘     │   │ │
│  │         │                   │          └───────────────────────────┘   │ │
│  │         │                   │                      │                   │ │
│  │         └───────────────────┴──────────────────────┘                   │ │
│  │                             │                                          │ │
│  │  ┌──────────────────────────┴──────────────────────────────────────┐  │ │
│  │  │                      PGlite Database                             │  │ │
│  │  │                   ~/.agentpane/data/                             │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         Git Worktrees                                   │ │
│  │  ~/projects/my-repo/.worktrees/                                        │ │
│  │  ├── agent-1-feature-branch/                                           │ │
│  │  ├── agent-2-bugfix-branch/                                            │ │
│  │  └── agent-3-refactor-branch/                                          │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS
                                    ▼
                    ┌───────────────────────────────┐
                    │       Anthropic API           │
                    │     api.anthropic.com         │
                    └───────────────────────────────┘
```

#### Local Installation Steps

```bash
# 1. Clone repository
git clone https://github.com/your-org/agentpane.git
cd agentpane

# 2. Install dependencies
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# 4. Initialize database
bun run db:push

# 5. Start application
bun run dev
```

#### Directory Structure (Local)

```
~/.agentpane/                    # Application data directory
├── data/
│   └── agentpane.db            # PGlite database file
├── settings.json               # User preferences (theme, shortcuts)
├── credentials.json            # Encrypted credentials (if not using env vars)
├── sessions/                   # Session history cache
└── cache/                      # Temporary cache

~/.claude/                       # Global Claude configuration
├── settings.json               # Global user settings
├── CLAUDE.md                   # Personal instructions
├── skills/                     # Personal skills
├── commands/                   # Personal slash commands
└── agents/                     # Personal subagents
```

---

### 1.2 Docker Containerization

#### Production Dockerfile

```dockerfile
# Dockerfile
FROM oven/bun:1.3.10-slim AS base
WORKDIR /app

# Install dependencies layer
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build layer
FROM base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NODE_ENV=production
RUN bun run build

# Production layer
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV BUN_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 agentpane && \
    adduser --system --uid 1001 --ingroup agentpane agentpane

# Create data directories
RUN mkdir -p /app/data /home/agentpane/.agentpane /home/agentpane/.claude && \
    chown -R agentpane:agentpane /app /home/agentpane

# Copy built artifacts
COPY --from=deps --chown=agentpane:agentpane /app/node_modules ./node_modules
COPY --from=builder --chown=agentpane:agentpane /app/.output ./.output
COPY --from=builder --chown=agentpane:agentpane /app/drizzle ./drizzle

USER agentpane

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5173/api/health || exit 1

EXPOSE 5173

# Environment variable placeholders
ENV ANTHROPIC_API_KEY=""
ENV DATABASE_URL="/app/data/agentpane.db"
ENV APP_URL="http://localhost:5173"
ENV LOG_LEVEL="info"

CMD ["bun", "run", ".output/server/index.mjs"]
```

#### Docker Compose Configuration

```yaml
# docker-compose.yml
version: '3.9'

services:
  agentpane:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: agentpane
    restart: unless-stopped
    ports:
      - "5173:5173"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITHUB_TOKEN=${GITHUB_TOKEN:-}
      - DATABASE_URL=/app/data/agentpane.db
      - APP_URL=${APP_URL:-http://localhost:5173}
      - NODE_ENV=production
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      # Persistent database storage
      - agentpane-data:/app/data
      # Mount user's Claude config (read-only)
      - ${HOME}/.claude:/home/agentpane/.claude:ro
      # Mount project directories for git worktrees
      - ${PROJECT_ROOT:-/home/user/projects}:/projects:rw
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5173/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=100m

volumes:
  agentpane-data:
    driver: local
```

#### Docker Commands

```bash
# Build image
docker build -t agentpane:latest .

# Run container
docker run -d \
  --name agentpane \
  -p 5173:5173 \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v agentpane-data:/app/data \
  -v "${HOME}/.claude:/home/agentpane/.claude:ro" \
  -v "${HOME}/projects:/projects:rw" \
  agentpane:latest

# View logs
docker logs -f agentpane

# Stop and remove
docker stop agentpane && docker rm agentpane
```

---

### 1.3 Cloud Deployment Options

For teams requiring multi-user access or higher availability, AgentPane can be deployed to cloud infrastructure.

#### Cloud Architecture (Scaled)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Cloud Provider                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Load Balancer / CDN                              │ │
│  │                    (CloudFront / Cloud CDN)                             │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                          │
│         ┌──────────────────────────┴──────────────────────────┐              │
│         │                                                      │              │
│         ▼                                                      ▼              │
│  ┌─────────────────┐                                   ┌─────────────────┐   │
│  │   Web Server    │                                   │   Web Server    │   │
│  │   Instance 1    │                                   │   Instance 2    │   │
│  │   (ECS/GKE)     │                                   │   (ECS/GKE)     │   │
│  └─────────────────┘                                   └─────────────────┘   │
│         │                                                      │              │
│         └──────────────────────────┬──────────────────────────┘              │
│                                    │                                          │
│                                    ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          Shared Storage                                 │ │
│  │                    (EFS / Cloud Filestore)                              │ │
│  │                                                                         │ │
│  │  ├── /data/agentpane.db         # PGlite database (single-writer)      │ │
│  │  ├── /projects/                 # Mounted project repositories          │ │
│  │  └── /config/                   # Shared configuration                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Agent Worker Pool                                │ │
│  │                     (Fargate / Cloud Run)                               │ │
│  │                                                                         │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐           │ │
│  │  │  Worker   │  │  Worker   │  │  Worker   │  │  Worker   │           │ │
│  │  │  1-3      │  │  4-6      │  │  7-9      │  │  10-12    │           │ │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘           │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### AWS Deployment (Terraform Example)

```hcl
# terraform/aws/main.tf

module "agentpane" {
  source = "./modules/agentpane"

  environment = "production"

  # ECS Configuration
  ecs_cluster_name = "agentpane-cluster"
  container_image  = "your-ecr-repo/agentpane:latest"
  desired_count    = 2
  cpu              = 1024
  memory           = 2048

  # Networking
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  # Storage
  efs_id = aws_efs_file_system.agentpane.id

  # Secrets
  anthropic_api_key_arn = aws_secretsmanager_secret.anthropic_key.arn
  github_token_arn      = aws_secretsmanager_secret.github_token.arn
}
```

#### Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentpane
  labels:
    app: agentpane
spec:
  replicas: 2
  selector:
    matchLabels:
      app: agentpane
  template:
    metadata:
      labels:
        app: agentpane
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: agentpane
          image: ghcr.io/your-org/agentpane:latest
          ports:
            - containerPort: 5173
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: agentpane-secrets
                  key: anthropic-api-key
            - name: DATABASE_URL
              value: "/data/agentpane.db"
            - name: NODE_ENV
              value: "production"
          volumeMounts:
            - name: data
              mountPath: /data
            - name: projects
              mountPath: /projects
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          livenessProbe:
            httpGet:
              path: /api/health
              port: 5173
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/health/ready
              port: 5173
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: agentpane-data
        - name: projects
          persistentVolumeClaim:
            claimName: agentpane-projects
```

---

## 2. Environment Configuration

### 2.1 Development Environment Setup

#### Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Bun | 1.3.0+ | 1.3.10 |
| Node.js | 22.0+ | 22.x LTS |
| Git | 2.40+ | Latest |
| Disk Space | 1 GB | 5 GB |
| RAM | 4 GB | 8 GB+ |

#### Development Setup

```bash
# Clone and setup
git clone https://github.com/your-org/agentpane.git
cd agentpane

# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Copy environment template
cp .env.example .env.development.local

# Initialize database
bun run db:push

# Start development server with hot reload
bun run dev
```

#### Development Environment File (.env.development.local)

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-api03-...

# Database (local PGlite)
DATABASE_URL=./data/agentpane.db

# Application
APP_URL=http://localhost:5173
NODE_ENV=development
LOG_LEVEL=debug

# Optional: GitHub Integration (for config sync)
GITHUB_TOKEN=ghp_...

# Optional: GitHub App (for full integration)
GITHUB_APP_ID=123456
GITHUB_APP_NAME=agentpane-dev
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=whsec_...

# Development-specific
VITE_DEV_TOOLS=true
DEBUG=agentpane:*
```

---

### 2.2 Production Environment Requirements

#### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8 GB+ |
| Disk | 10 GB SSD | 50 GB+ SSD |
| Network | 10 Mbps | 100 Mbps+ |

#### Production Environment File

```bash
# Required - API Access
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required - Database
DATABASE_URL=/app/data/agentpane.db

# Required - Application URL (for session sharing links)
APP_URL=https://agentpane.your-domain.com

# Required - Environment
NODE_ENV=production

# Logging
LOG_LEVEL=info

# Optional - GitHub Integration
GITHUB_TOKEN=ghp_...

# Optional - GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_NAME=agentpane-prod
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=<from-secrets-manager>
GITHUB_PRIVATE_KEY=<from-secrets-manager>
GITHUB_WEBHOOK_SECRET=<from-secrets-manager>

# Performance tuning
MAX_CONCURRENT_AGENTS=6
MAX_TURNS_PER_AGENT=100
AGENT_TIMEOUT_MS=600000
```

---

### 2.3 Environment Variable Management

#### Variable Precedence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Process Environment (highest priority)                                    │
│    - Set via shell: ANTHROPIC_API_KEY=sk-... bun run dev                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Environment-Specific File                                                 │
│    - .env.development.local (dev) or .env.production.local (prod)           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Base Environment File                                                     │
│    - .env.local (not committed, machine-specific)                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Default Environment File                                                  │
│    - .env (committed, contains non-sensitive defaults)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Application Defaults (lowest priority)                                    │
│    - Hard-coded in lib/config/defaults.ts                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Claude API key |
| `DATABASE_URL` | No | `./data/agentpane.db` | PGlite database path |
| `APP_URL` | No | `http://localhost:5173` | Application base URL |
| `NODE_ENV` | No | `development` | Environment mode |
| `LOG_LEVEL` | No | `info` | Logging verbosity |
| `GITHUB_TOKEN` | No | - | GitHub PAT for basic integration |
| `GITHUB_APP_ID` | No | - | GitHub App ID |
| `GITHUB_CLIENT_ID` | No | - | OAuth client ID |
| `GITHUB_CLIENT_SECRET` | No | - | OAuth client secret |
| `GITHUB_PRIVATE_KEY` | No | - | App private key (PEM) |
| `GITHUB_WEBHOOK_SECRET` | No | - | Webhook signature secret |
| `MAX_CONCURRENT_AGENTS` | No | `3` | Max parallel agents |
| `MAX_TURNS_PER_AGENT` | No | `50` | Max turns per execution |

---

### 2.4 Secrets Handling

#### Local Development

For local development, secrets are stored in `.env.local` (gitignored):

```bash
# .env.local (never commit)
ANTHROPIC_API_KEY=sk-ant-api03-...
GITHUB_TOKEN=ghp_...
GITHUB_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
```

#### Production Secrets (AWS Secrets Manager)

```typescript
// lib/config/secrets-loader.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface SecretConfig {
  ANTHROPIC_API_KEY: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

export async function loadSecrets(): Promise<SecretConfig> {
  if (process.env.NODE_ENV !== 'production') {
    // Use environment variables directly in development
    return {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    };
  }

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  const command = new GetSecretValueCommand({
    SecretId: process.env.SECRETS_ARN ?? 'agentpane/production',
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error('Failed to load secrets from Secrets Manager');
  }

  return JSON.parse(response.SecretString);
}
```

#### Security Best Practices

| Practice | Implementation |
|----------|----------------|
| No secrets in code | Use environment variables only |
| No secrets in logs | Redact sensitive values in logging |
| Rotate credentials | Implement key rotation procedures |
| Principle of least privilege | Minimal API key permissions |
| Encrypt at rest | Use encrypted secrets manager |
| Encrypt in transit | HTTPS only, TLS 1.3 |

---

## 3. Build Process

### 3.1 Build Commands and Scripts

#### package.json Scripts

```json
{
  "scripts": {
    "dev": "vinxi dev",
    "build": "vinxi build",
    "start": "vinxi start",
    "preview": "vinxi build && vinxi start",

    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",

    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage",
    "test:e2e": "playwright test",

    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "typecheck": "tsc --noEmit",

    "clean": "rm -rf .output node_modules/.vite",
    "clean:all": "rm -rf .output node_modules .vinxi",

    "bundle:analyze": "ANALYZE=true bun run build",
    "build:docker": "docker build -t agentpane:latest ."
  }
}
```

#### Build Pipeline

```bash
# Full build pipeline
bun run clean
bun run typecheck
bun run lint
bun run test
bun run build
```

---

### 3.2 Asset Optimization

#### Vite Configuration

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    mode === 'analyze' && visualizer({
      open: true,
      filename: '.output/stats.html',
      gzipSize: true,
      brotliSize: true,
    }),
  ].filter(Boolean),

  build: {
    // Enable minification
    minify: 'esbuild',

    // Code splitting
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks
          'vendor-react': ['react', 'react-dom'],
          'vendor-tanstack': [
            '@tanstack/react-router',
            '@tanstack/react-query',
            '@tanstack/db',
          ],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable'],
        },
      },
    },

    // Asset handling
    assetsInlineLimit: 4096, // Inline assets < 4KB

    // Source maps for production debugging
    sourcemap: mode === 'production' ? 'hidden' : true,

    // Output directory
    outDir: '.output/client',
  },

  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@tanstack/react-router',
      '@dnd-kit/core',
    ],
  },
}));
```

#### Build Output Structure

```
.output/
├── client/                      # Client-side assets
│   ├── assets/
│   │   ├── index-[hash].js      # Main bundle
│   │   ├── vendor-react-[hash].js
│   │   ├── vendor-tanstack-[hash].js
│   │   ├── vendor-radix-[hash].js
│   │   └── index-[hash].css     # Compiled Tailwind CSS
│   └── index.html
├── server/
│   └── index.mjs                # Server entry point
└── stats.html                   # Bundle analysis (if ANALYZE=true)
```

---

### 3.3 Bundle Analysis

#### Analyze Build Size

```bash
# Generate bundle analysis
ANALYZE=true bun run build

# Opens interactive treemap in browser
# Shows gzip and brotli sizes for each chunk
```

#### Size Budgets

| Bundle | Max Size (gzip) | Description |
|--------|-----------------|-------------|
| Main JS | 150 KB | Core application code |
| Vendor React | 50 KB | React and React DOM |
| Vendor TanStack | 80 KB | Router, Query, DB |
| Vendor Radix | 60 KB | UI components |
| CSS | 30 KB | Tailwind styles |
| Total Initial | 300 KB | First load |

#### Performance Monitoring

```typescript
// lib/metrics/bundle-metrics.ts
export function reportBundleMetrics() {
  if (typeof window === 'undefined') return;

  // Report to analytics
  const entries = performance.getEntriesByType('resource');
  const jsEntries = entries.filter(e => e.name.endsWith('.js'));
  const cssEntries = entries.filter(e => e.name.endsWith('.css'));

  const metrics = {
    jsSize: jsEntries.reduce((sum, e) => sum + (e as PerformanceResourceTiming).transferSize, 0),
    cssSize: cssEntries.reduce((sum, e) => sum + (e as PerformanceResourceTiming).transferSize, 0),
    jsCount: jsEntries.length,
    loadTime: performance.now(),
  };

  console.log('[Bundle Metrics]', metrics);
}
```

---

## 4. Database Management

### 4.1 PGlite Initialization

#### Database Client Setup

```typescript
// lib/db/client.ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { configService } from '../config/config-service';

let pglite: PGlite | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export async function initializeDatabase(): Promise<ReturnType<typeof drizzle>> {
  if (db) return db;

  const appConfig = configService.getAppConfig();
  const databasePath = appConfig.databasePath;

  console.log(`[Database] Initializing PGlite at: ${databasePath}`);

  pglite = new PGlite(databasePath, {
    // Enable WAL mode for better concurrent access
    pragmas: {
      journal_mode: 'wal',
      synchronous: 'normal',
      cache_size: -64000, // 64MB cache
    },
  });

  db = drizzle(pglite, { schema });

  // Run migrations on startup
  await runMigrations(db);

  console.log('[Database] Initialization complete');
  return db;
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (pglite) {
    await pglite.close();
    pglite = null;
    db = null;
    console.log('[Database] Connection closed');
  }
}
```

#### Database Health Check

```typescript
// lib/db/health.ts
import { getDatabase } from './client';
import { sql } from 'drizzle-orm';

export interface DatabaseHealth {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  size: number;
  walSize: number;
  error?: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startTime = performance.now();

  try {
    const db = getDatabase();

    // Simple connectivity check
    await db.execute(sql`SELECT 1`);

    // Get database stats
    const [stats] = await db.execute<{ size: number; wal_size: number }>(sql`
      SELECT
        page_count * page_size as size,
        (SELECT page_count * page_size FROM pragma_wal_checkpoint) as wal_size
      FROM pragma_page_count, pragma_page_size
    `);

    return {
      status: 'healthy',
      latencyMs: Math.round(performance.now() - startTime),
      size: stats?.size ?? 0,
      walSize: stats?.wal_size ?? 0,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Math.round(performance.now() - startTime),
      size: 0,
      walSize: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

---

### 4.2 Migration Strategies

#### Drizzle Migrations

```typescript
// lib/db/migrations.ts
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';

export async function runMigrations(db: PgDatabase): Promise<void> {
  console.log('[Migrations] Running database migrations...');

  try {
    await migrate(db, {
      migrationsFolder: './drizzle',
    });
    console.log('[Migrations] All migrations applied successfully');
  } catch (error) {
    console.error('[Migrations] Failed to run migrations:', error);
    throw error;
  }
}
```

#### Migration Commands

```bash
# Generate migration from schema changes
bun run db:generate

# Apply migrations to database
bun run db:migrate

# Push schema directly (development only)
bun run db:push

# Open Drizzle Studio for database inspection
bun run db:studio
```

#### Migration File Structure

```
drizzle/
├── meta/
│   └── _journal.json           # Migration history
├── 0000_initial_schema.sql     # Initial tables
├── 0001_add_sessions.sql       # Add sessions table
├── 0002_add_worktrees.sql      # Add worktrees table
└── 0003_add_github_config.sql  # GitHub integration
```

---

### 4.3 Backup and Restore Procedures

#### Backup Script

```bash
#!/bin/bash
# scripts/backup-database.sh

set -euo pipefail

# Configuration
DATA_DIR="${DATA_DIR:-$HOME/.agentpane/data}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.agentpane/backups}"
DB_FILE="agentpane.db"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agentpane_${TIMESTAMP}.db"

echo "[Backup] Starting database backup..."

# Checkpoint WAL before backup (ensures consistency)
if [ -f "$DATA_DIR/$DB_FILE" ]; then
  sqlite3 "$DATA_DIR/$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);"
fi

# Copy database file
cp "$DATA_DIR/$DB_FILE" "$BACKUP_FILE"

# Compress backup
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

echo "[Backup] Created: $BACKUP_FILE"

# Calculate size
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[Backup] Size: $SIZE"

# Clean up old backups
echo "[Backup] Cleaning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "agentpane_*.db.gz" -mtime +$RETENTION_DAYS -delete

# List current backups
echo "[Backup] Current backups:"
ls -lh "$BACKUP_DIR"/*.gz 2>/dev/null || echo "  No backups found"

echo "[Backup] Complete"
```

#### Restore Script

```bash
#!/bin/bash
# scripts/restore-database.sh

set -euo pipefail

# Configuration
DATA_DIR="${DATA_DIR:-$HOME/.agentpane/data}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.agentpane/backups}"
DB_FILE="agentpane.db"

# Usage
if [ $# -eq 0 ]; then
  echo "Usage: $0 <backup-file>"
  echo ""
  echo "Available backups:"
  ls -lh "$BACKUP_DIR"/*.gz 2>/dev/null || echo "  No backups found"
  exit 1
fi

BACKUP_FILE="$1"

# Validate backup file
if [ ! -f "$BACKUP_FILE" ]; then
  echo "[Restore] Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "[Restore] Starting database restore from: $BACKUP_FILE"

# Stop AgentPane if running
if pgrep -f "agentpane" > /dev/null; then
  echo "[Restore] Warning: AgentPane is running. Please stop it first."
  exit 1
fi

# Backup current database (safety)
if [ -f "$DATA_DIR/$DB_FILE" ]; then
  CURRENT_BACKUP="$BACKUP_DIR/agentpane_pre_restore_$(date +%Y%m%d_%H%M%S).db"
  echo "[Restore] Backing up current database to: $CURRENT_BACKUP"
  cp "$DATA_DIR/$DB_FILE" "$CURRENT_BACKUP"
fi

# Remove WAL files
rm -f "$DATA_DIR/$DB_FILE-wal" "$DATA_DIR/$DB_FILE-shm"

# Restore from backup
echo "[Restore] Decompressing backup..."
gunzip -c "$BACKUP_FILE" > "$DATA_DIR/$DB_FILE"

# Verify restored database
echo "[Restore] Verifying database integrity..."
if sqlite3 "$DATA_DIR/$DB_FILE" "PRAGMA integrity_check;" | grep -q "ok"; then
  echo "[Restore] Database integrity check passed"
else
  echo "[Restore] Error: Database integrity check failed!"
  exit 1
fi

echo "[Restore] Complete. You can now start AgentPane."
```

#### Automated Backup (Cron)

```bash
# crontab -e
# Daily backup at 2 AM
0 2 * * * /path/to/agentpane/scripts/backup-database.sh >> /var/log/agentpane-backup.log 2>&1
```

---

### 4.4 Data Directory Management

#### Directory Structure

```
~/.agentpane/
├── data/
│   ├── agentpane.db            # Main database file
│   ├── agentpane.db-wal        # Write-ahead log (auto-managed)
│   └── agentpane.db-shm        # Shared memory (auto-managed)
├── backups/
│   ├── agentpane_20260117_020000.db.gz
│   └── agentpane_20260116_020000.db.gz
├── cache/
│   └── github/                 # Cached GitHub API responses
├── logs/
│   ├── agentpane.log           # Application logs
│   └── agent-*.log             # Agent execution logs
└── sessions/
    └── *.json                  # Session state snapshots
```

#### Disk Space Management

```typescript
// lib/storage/disk-manager.ts
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface DiskUsage {
  database: number;
  backups: number;
  cache: number;
  logs: number;
  total: number;
}

export async function getDiskUsage(dataDir: string): Promise<DiskUsage> {
  const usage: DiskUsage = {
    database: 0,
    backups: 0,
    cache: 0,
    logs: 0,
    total: 0,
  };

  // Calculate database size
  try {
    const dbStat = await stat(join(dataDir, 'data', 'agentpane.db'));
    usage.database = dbStat.size;
  } catch {}

  // Calculate directory sizes
  usage.backups = await getDirectorySize(join(dataDir, 'backups'));
  usage.cache = await getDirectorySize(join(dataDir, 'cache'));
  usage.logs = await getDirectorySize(join(dataDir, 'logs'));

  usage.total = usage.database + usage.backups + usage.cache + usage.logs;

  return usage;
}

export async function cleanupCache(
  dataDir: string,
  maxAgeDays: number = 7
): Promise<number> {
  const cacheDir = join(dataDir, 'cache');
  const threshold = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let freedBytes = 0;

  const files = await readdir(cacheDir, { recursive: true });

  for (const file of files) {
    const filePath = join(cacheDir, file);
    const fileStat = await stat(filePath);

    if (fileStat.isFile() && fileStat.mtimeMs < threshold) {
      freedBytes += fileStat.size;
      await unlink(filePath);
    }
  }

  return freedBytes;
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let size = 0;

  try {
    const files = await readdir(dirPath, { recursive: true });

    for (const file of files) {
      try {
        const fileStat = await stat(join(dirPath, file));
        if (fileStat.isFile()) {
          size += fileStat.size;
        }
      } catch {}
    }
  } catch {}

  return size;
}
```

---

## 5. CI/CD Pipeline

### 5.1 GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  BUN_VERSION: "1.3.10"
  NODE_VERSION: "22"

jobs:
  # ─────────────────────────────────────────────────────────────────
  # Lint and Type Check
  # ─────────────────────────────────────────────────────────────────
  lint:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run Biome lint
        run: bun run lint

      - name: Run TypeScript type check
        run: bun run typecheck

  # ─────────────────────────────────────────────────────────────────
  # Unit Tests
  # ─────────────────────────────────────────────────────────────────
  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run unit tests
        run: bun run test:coverage

      - name: Upload coverage report
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          fail_ci_if_error: true

  # ─────────────────────────────────────────────────────────────────
  # Build
  # ─────────────────────────────────────────────────────────────────
  build:
    name: Build Application
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build application
        run: bun run build
        env:
          NODE_ENV: production

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: .output/
          retention-days: 7

  # ─────────────────────────────────────────────────────────────────
  # E2E Tests
  # ─────────────────────────────────────────────────────────────────
  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Install Playwright browsers
        run: bunx playwright install --with-deps chromium

      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: build-output
          path: .output/

      - name: Run E2E tests
        run: bun run test:e2e
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_TEST }}

      - name: Upload test results
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/

  # ─────────────────────────────────────────────────────────────────
  # Docker Build
  # ─────────────────────────────────────────────────────────────────
  docker:
    name: Build Docker Image
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=sha,prefix=
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ─────────────────────────────────────────────────────────────────
  # Deploy (Production)
  # ─────────────────────────────────────────────────────────────────
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [e2e, docker]
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - name: Deploy to production
        run: |
          echo "Deploying to production..."
          # Add deployment commands here
          # e.g., kubectl rollout, AWS ECS update, etc.
```

---

### 5.2 Build Stages

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CI/CD Pipeline                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │    Lint     │────▶│    Test     │────▶│    Build    │────▶│    E2E    │ │
│  │             │     │             │     │             │     │           │ │
│  │ - Biome     │     │ - Vitest    │     │ - vinxi     │     │ - Playwright │
│  │ - TypeScript│     │ - Coverage  │     │ - Bundle    │     │           │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └───────────┘ │
│        │                   │                   │                   │         │
│        └───────────────────┴───────────────────┴───────────────────┘         │
│                                    │                                          │
│                                    ▼                                          │
│                          ┌─────────────────┐                                 │
│                          │     Docker      │                                 │
│                          │   Build/Push    │                                 │
│                          └─────────────────┘                                 │
│                                    │                                          │
│                                    ▼                                          │
│                          ┌─────────────────┐                                 │
│                          │     Deploy      │                                 │
│                          │  (Production)   │                                 │
│                          └─────────────────┘                                 │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 5.3 Artifact Management

#### Build Artifacts

| Artifact | Contents | Retention |
|----------|----------|-----------|
| `build-output` | `.output/` directory | 7 days |
| `playwright-report` | E2E test results | 7 days (on failure) |
| `coverage-report` | Test coverage data | 30 days |
| `docker-image` | Container image | Permanent (latest + tags) |

#### Docker Image Tags

| Tag | Description | When Updated |
|-----|-------------|--------------|
| `latest` | Most recent main build | Every main merge |
| `<sha>` | Specific commit | Every build |
| `v<version>` | Release version | On release |
| `develop` | Development branch | Every develop merge |

---

### 5.4 Rollback Procedures

#### Quick Rollback (Docker)

```bash
# List available image tags
docker images ghcr.io/your-org/agentpane --format "{{.Tag}}"

# Rollback to previous version
docker stop agentpane
docker rm agentpane
docker run -d \
  --name agentpane \
  -p 5173:5173 \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v agentpane-data:/app/data \
  ghcr.io/your-org/agentpane:<previous-sha>
```

#### Kubernetes Rollback

```bash
# View rollout history
kubectl rollout history deployment/agentpane

# Rollback to previous revision
kubectl rollout undo deployment/agentpane

# Rollback to specific revision
kubectl rollout undo deployment/agentpane --to-revision=2

# Check rollback status
kubectl rollout status deployment/agentpane
```

#### Database Rollback

```bash
# If a migration caused issues:
# 1. Stop the application
docker stop agentpane

# 2. Restore from pre-migration backup
./scripts/restore-database.sh ~/.agentpane/backups/agentpane_pre_migrate.db.gz

# 3. Deploy previous application version
docker run ... ghcr.io/your-org/agentpane:<previous-version>
```

---

## 6. Infrastructure Requirements

### 6.1 Hardware Requirements

#### Local Development

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| CPU | 2 cores | 4+ cores | More cores = more concurrent agents |
| RAM | 4 GB | 8 GB+ | Each agent uses ~200-500 MB |
| Disk | 2 GB | 10 GB+ SSD | Database + worktrees |
| Network | 5 Mbps | 50 Mbps+ | API calls to Anthropic |

#### Production Server

| Resource | Small | Medium | Large |
|----------|-------|--------|-------|
| CPU | 2 vCPU | 4 vCPU | 8+ vCPU |
| RAM | 4 GB | 8 GB | 16+ GB |
| Disk | 20 GB SSD | 50 GB SSD | 100+ GB SSD |
| Max Agents | 3 | 6 | 10+ |

### 6.2 Network Requirements

#### Outbound Connections

| Destination | Port | Protocol | Purpose |
|-------------|------|----------|---------|
| api.anthropic.com | 443 | HTTPS | Claude API |
| api.github.com | 443 | HTTPS | GitHub API |
| registry.npmjs.org | 443 | HTTPS | Package registry |
| ghcr.io | 443 | HTTPS | Container registry |

#### Firewall Rules (Inbound)

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 5173 | TCP | localhost / LAN | Application |
| 443 | TCP | GitHub IPs | Webhooks (if enabled) |

#### Proxy Configuration

```bash
# If behind corporate proxy
export HTTP_PROXY=http://proxy.company.com:8080
export HTTPS_PROXY=http://proxy.company.com:8080
export NO_PROXY=localhost,127.0.0.1,.company.com
```

### 6.3 Browser Compatibility

| Browser | Minimum Version | Recommended |
|---------|-----------------|-------------|
| Chrome | 120+ | Latest |
| Firefox | 120+ | Latest |
| Safari | 17+ | Latest |
| Edge | 120+ | Latest |

#### Required Browser Features

- WebSocket support
- Server-Sent Events (SSE)
- ES2022+ JavaScript
- CSS Grid and Flexbox
- IndexedDB (for offline caching)

---

## 7. Startup Sequence

### 7.1 Service Initialization Order

```typescript
// lib/bootstrap/startup.ts
import { initializeDatabase } from '../db/client';
import { validateEnv } from '../config/validate-env';
import { initializeDurableStreams } from '../streams/server';
import { initializeAgentPool } from '../agents/pool';
import { startHealthCheck } from '../health/server';
import { startServer } from '../server';

export async function bootstrap(): Promise<void> {
  console.log('[Bootstrap] Starting AgentPane...');

  // ─────────────────────────────────────────────────────────────────
  // Phase 1: Configuration Validation
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 1: Validating configuration...');

  const envResult = validateEnv();
  if (!envResult.ok) {
    console.error('[Bootstrap] Environment validation failed:', envResult.error);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 2: Database Initialization
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 2: Initializing database...');

  try {
    await initializeDatabase();
  } catch (error) {
    console.error('[Bootstrap] Database initialization failed:', error);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 3: Durable Streams Setup
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 3: Initializing Durable Streams...');

  try {
    await initializeDurableStreams();
  } catch (error) {
    console.error('[Bootstrap] Durable Streams initialization failed:', error);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 4: Agent Pool Initialization
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 4: Initializing agent pool...');

  try {
    await initializeAgentPool({
      maxConcurrent: envResult.value.MAX_CONCURRENT_AGENTS ?? 3,
    });
  } catch (error) {
    console.error('[Bootstrap] Agent pool initialization failed:', error);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 5: Health Check Server
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 5: Starting health check endpoint...');

  startHealthCheck();

  // ─────────────────────────────────────────────────────────────────
  // Phase 6: HTTP Server
  // ─────────────────────────────────────────────────────────────────
  console.log('[Bootstrap] Phase 6: Starting HTTP server...');

  await startServer();

  console.log('[Bootstrap] AgentPane started successfully');
}
```

#### Startup Sequence Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Startup Sequence                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Time ─────────────────────────────────────────────────────────────────────▶ │
│                                                                               │
│  ┌──────────────┐                                                            │
│  │ Phase 1:     │ Validate environment variables                             │
│  │ Config       │ Load .env files                                            │
│  └──────────────┘ Check required secrets                                     │
│         │                                                                     │
│         ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ Phase 2:     │ Initialize PGlite connection                               │
│  │ Database     │ Run pending migrations                                     │
│  └──────────────┘ Verify database health                                     │
│         │                                                                     │
│         ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ Phase 3:     │ Initialize server publisher                                │
│  │ Streams      │ Set up event routing                                       │
│  └──────────────┘ Connect to session store                                   │
│         │                                                                     │
│         ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ Phase 4:     │ Create agent worker pool                                   │
│  │ Agent Pool   │ Initialize concurrency limiter                             │
│  └──────────────┘ Restore pending tasks                                      │
│         │                                                                     │
│         ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ Phase 5:     │ Start /api/health endpoint                                 │
│  │ Health Check │ Register liveness probe                                    │
│  └──────────────┘ Register readiness probe                                   │
│         │                                                                     │
│         ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ Phase 6:     │ Bind to port 5173                                          │
│  │ HTTP Server  │ Start accepting requests                                   │
│  └──────────────┘ Application ready                                          │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 7.2 Health Check Integration

#### Health Check Endpoints

```typescript
// app/routes/api/health.ts
import { createServerFileRoute } from '@tanstack/react-start/server';
import { checkDatabaseHealth } from '@/lib/db/health';
import { checkAgentPoolHealth } from '@/lib/agents/health';
import { checkStreamsHealth } from '@/lib/streams/health';

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  checks: {
    database: { status: string; latencyMs: number };
    agentPool: { status: string; activeAgents: number; maxAgents: number };
    streams: { status: string; activeConnections: number };
  };
}

export const ServerRoute = createServerFileRoute().methods({
  // Liveness probe - is the process alive?
  GET: async () => {
    const startTime = process.hrtime.bigint();

    const [dbHealth, poolHealth, streamsHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkAgentPoolHealth(),
      checkStreamsHealth(),
    ]);

    const allHealthy =
      dbHealth.status === 'healthy' &&
      poolHealth.status === 'healthy' &&
      streamsHealth.status === 'healthy';

    const response: HealthResponse = {
      status: allHealthy ? 'healthy' : 'degraded',
      version: process.env.npm_package_version ?? '0.0.0',
      uptime: process.uptime(),
      checks: {
        database: {
          status: dbHealth.status,
          latencyMs: dbHealth.latencyMs,
        },
        agentPool: {
          status: poolHealth.status,
          activeAgents: poolHealth.activeAgents,
          maxAgents: poolHealth.maxAgents,
        },
        streams: {
          status: streamsHealth.status,
          activeConnections: streamsHealth.activeConnections,
        },
      },
    };

    return Response.json(response, {
      status: allHealthy ? 200 : 503,
    });
  },
});

// Readiness probe - is the app ready to receive traffic?
export const ReadyRoute = createServerFileRoute('/api/health/ready').methods({
  GET: async () => {
    const dbHealth = await checkDatabaseHealth();

    if (dbHealth.status !== 'healthy') {
      return Response.json(
        { ready: false, reason: 'Database not ready' },
        { status: 503 }
      );
    }

    return Response.json({ ready: true }, { status: 200 });
  },
});
```

---

### 7.3 Graceful Shutdown

```typescript
// lib/bootstrap/shutdown.ts
import { closeDatabase } from '../db/client';
import { stopAgentPool } from '../agents/pool';
import { closeDurableStreams } from '../streams/server';

let isShuttingDown = false;

export function setupGracefulShutdown(): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  for (const signal of signals) {
    process.on(signal, () => handleShutdown(signal));
  }

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('[Shutdown] Uncaught exception:', error);
    handleShutdown('UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Shutdown] Unhandled rejection:', reason);
    // Don't exit on unhandled rejection, just log
  });
}

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[Shutdown] Already shutting down...');
    return;
  }

  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error('[Shutdown] Timeout exceeded, forcing exit');
    process.exit(1);
  }, 30000); // 30 second timeout

  try {
    // ─────────────────────────────────────────────────────────────────
    // Phase 1: Stop accepting new requests
    // ─────────────────────────────────────────────────────────────────
    console.log('[Shutdown] Phase 1: Stopping HTTP server...');
    // Server stop handled by TanStack Start

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: Wait for running agents to complete (with timeout)
    // ─────────────────────────────────────────────────────────────────
    console.log('[Shutdown] Phase 2: Waiting for agents to complete...');
    await stopAgentPool({ timeout: 15000 });

    // ─────────────────────────────────────────────────────────────────
    // Phase 3: Close Durable Streams connections
    // ─────────────────────────────────────────────────────────────────
    console.log('[Shutdown] Phase 3: Closing stream connections...');
    await closeDurableStreams();

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: Close database connection
    // ─────────────────────────────────────────────────────────────────
    console.log('[Shutdown] Phase 4: Closing database...');
    await closeDatabase();

    clearTimeout(shutdownTimeout);
    console.log('[Shutdown] Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Shutdown] Error during shutdown:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}
```

---

## 8. Troubleshooting Guide

### 8.1 Common Issues and Solutions

#### Database Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| Database locked | "database is locked" error | Ensure single writer; check for stale processes |
| Corrupted database | Application crashes on start | Restore from backup |
| Migration failed | "migration failed" error | Check migration logs; fix and re-run |
| Out of disk space | Write operations fail | Clean cache, old backups |

```bash
# Check for stale processes
pgrep -f agentpane

# Kill stale processes
pkill -f agentpane

# Verify database integrity
sqlite3 ~/.agentpane/data/agentpane.db "PRAGMA integrity_check;"

# Vacuum database to reclaim space
sqlite3 ~/.agentpane/data/agentpane.db "VACUUM;"
```

#### Agent Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| Agent stuck | Status shows "running" indefinitely | Check for API errors; restart agent |
| Rate limiting | 429 errors from Anthropic | Reduce concurrent agents; add delays |
| Tool failures | Agent can't execute tools | Check permissions; verify paths |
| Worktree conflicts | Git errors during agent execution | Clean up stale worktrees |

```bash
# List all worktrees
git worktree list

# Remove stale worktrees
git worktree prune

# Force remove specific worktree
git worktree remove --force .worktrees/stale-branch
```

#### Connection Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| SSE disconnects | Real-time updates stop | Check network; refresh browser |
| WebSocket failures | Terminal doesn't respond | Verify proxy settings; check firewall |
| API timeouts | Slow responses from Anthropic | Check network latency; retry |

---

### 8.2 Debug Mode Configuration

#### Enable Debug Logging

```bash
# Development
DEBUG=agentpane:* LOG_LEVEL=debug bun run dev

# Production (temporary)
LOG_LEVEL=debug docker restart agentpane
```

#### Debug Environment Variables

```bash
# Enable all debug output
DEBUG=agentpane:*

# Enable specific modules
DEBUG=agentpane:agents,agentpane:db

# Enable verbose API logging
DEBUG_ANTHROPIC_API=true

# Enable SQL query logging
DEBUG_SQL=true
```

#### Logging Configuration

```typescript
// lib/logging/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      }
    : undefined,
  redact: {
    paths: [
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_PRIVATE_KEY',
    ],
    censor: '[REDACTED]',
  },
});
```

---

### 8.3 Log Analysis

#### Log Locations

| Log Type | Location | Purpose |
|----------|----------|---------|
| Application | stdout/stderr | Main application logs |
| Agent execution | `~/.agentpane/logs/agent-*.log` | Per-agent execution logs |
| Database | `~/.agentpane/logs/db.log` | Query and migration logs |
| Access | `~/.agentpane/logs/access.log` | HTTP request logs |

#### Log Format

```
# Standard log entry
{"level":"info","time":1705500000000,"msg":"Agent started","agentId":"clx123","taskId":"task456"}

# Error log entry
{"level":"error","time":1705500001000,"msg":"Agent execution failed","agentId":"clx123","err":{"message":"Tool failed","code":"TOOL_ERROR"}}
```

#### Log Analysis Commands

```bash
# View recent errors
cat ~/.agentpane/logs/agentpane.log | jq 'select(.level == "error")' | head -20

# Count errors by type
cat ~/.agentpane/logs/agentpane.log | jq -r 'select(.level == "error") | .err.code' | sort | uniq -c

# Find slow operations (>5s)
cat ~/.agentpane/logs/agentpane.log | jq 'select(.duration > 5000)'

# Track specific agent
cat ~/.agentpane/logs/agentpane.log | jq 'select(.agentId == "clx123")'
```

#### Centralized Logging (Production)

```typescript
// lib/logging/transport.ts
import pino from 'pino';

// For cloud deployments, ship logs to centralized logging
export const cloudTransport = pino.transport({
  targets: [
    // Console output
    {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    },
    // CloudWatch (AWS)
    {
      target: '@serdnam/pino-cloudwatch-transport',
      options: {
        logGroupName: 'agentpane-production',
        logStreamName: process.env.HOSTNAME ?? 'unknown',
        awsRegion: process.env.AWS_REGION ?? 'us-east-1',
      },
    },
  ],
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [App Bootstrap](../architecture/app-bootstrap.md) | Detailed initialization sequence |
| [Database Schema](../database/schema.md) | Schema definitions and relationships |
| [Configuration Management](../configuration/config-management.md) | Environment and config loading |
| [Security Model](../security/security-model.md) | Secrets and authentication |
| [Error Catalog](../errors/error-catalog.md) | Error codes for troubleshooting |
| [Durable Sessions](../integrations/durable-sessions.md) | Real-time event streaming setup |
| [Claude Agent SDK](../integrations/claude-agent-sdk.md) | Agent pool configuration |
