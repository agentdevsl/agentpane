# Release & Deployment Assessment

## Current CI Pipeline

### What Exists

The CI pipeline (`.github/workflows/ci.yml`) is well-structured with proper job dependencies, caching, and parallelism:

| Job | Purpose | Status |
|-----|---------|--------|
| **install** | `bun install --frozen-lockfile` with node_modules + Bun cache | Solid |
| **lint-and-typecheck** | Schema drift check + `tsc --noEmit` + Biome check | Solid |
| **test** (3 shards) | Unit/jsdom/db tests, sharded 1/3, 2/3, 3/3 | Solid |
| **build** | Full build verification including agent-runner | Solid |
| **semgrep** | SAST scan: ERROR severity blocking, WARNING non-blocking | Solid |
| **integration-test** (2 shards) | Integration + functional tests after all other jobs pass | Solid |

**Strengths:**
- Concurrency control with `cancel-in-progress: true` prevents redundant runs
- `--frozen-lockfile` ensures reproducible builds
- Schema drift detection between SQLite and PostgreSQL schemas in CI
- Reusable composite action `.github/actions/setup-bun-env` for consistent environment setup
- Test failure artifacts uploaded for debugging
- Semgrep SAST scanning with custom rules in `.semgrep/rules/`
- Mutation testing workflow (`.github/workflows/mutation-testing.yml`) runs on state-machines and RBAC changes plus daily schedule

**Concerns:**
- Dependency audit runs inside the test job with `continue-on-error: true` -- audit results are never gating and could be missed
- No coverage reporting or enforcement
- No Docker image build/push in CI -- the build job only verifies `bun run build`, not the Docker image
- Mutation testing is `continue-on-error: true` and does not gate merges

---

## Deployment Infrastructure

### Docker (docker/Dockerfile)

**Architecture:** Multi-stage build with 4 stages: deps -> build -> caddy binary download -> runtime.

**Strengths:**
- Multi-stage build minimizes final image size
- Non-root user (`bun`) in production
- `tini` as PID 1 for proper signal forwarding
- HEALTHCHECK directive for container orchestration
- WAL mode SQLite for concurrent read performance
- Persistent data volumes for SQLite and durable streams
- `TARGETARCH` support for multi-architecture builds (amd64/arm64)

**Concerns:**
1. **Entire `src/` directory copied into runtime image** (line 56: `COPY --from=build /app/src ./src`). This means source code ships in production. This is needed because Bun runs TypeScript directly (`bun src/server/api.ts`), but it increases attack surface and image size.
2. **No `.dockerignore` was checked** -- risk of bloating context with node_modules, .git, tests.
3. **No image scanning** (Trivy, Grype, etc.) in CI.
4. **No image build/push workflow** -- images must be built and pushed manually.
5. **durable-streams-server binary downloaded from GitHub Releases** at build time (v0.2.1 hardcoded). No version pinning via checksum verification.
6. **No multi-stage optimization for node_modules** -- `--production=false` in deps stage means dev dependencies are installed, then the full `node_modules` is copied to runtime.

### Docker Compose

Three compose files exist:

| File | Purpose | Production Ready? |
|------|---------|-------------------|
| `docker-compose.yml` | Main app with SQLite | Development/demo only |
| `docker-compose.postgres.yml` | PostgreSQL sidecar | Dev only (hardcoded credentials: `agentpane_dev`) |
| `docker-compose.memory.yml` | Honcho memory service stack | Dev only |

**Concerns:**
- No production compose file with proper secret management
- No compose profiles for staging vs production
- PostgreSQL password is hardcoded (`agentpane_dev`)
- No resource limits defined in compose files
- No logging driver configuration

### start.sh (Process Manager)

The start script (`docker/start.sh`) runs Caddy and the Bun API as two child processes.

**Strengths:**
- Signal trapping for clean shutdown (SIGTERM/SIGINT)
- Caddy readiness polling before starting the API
- Exit code propagation from failed child processes

**Concerns:**
- Running two processes in one container is an anti-pattern for K8s (difficult to restart one without the other, obscures health status)
- The Helm chart deploys to K8s **without Caddy** (containerPort 3001, direct API access). This means the Docker image has Caddy baked in but the K8s deployment bypasses it -- a divergent architecture between Docker and K8s deployments
- If Caddy crashes but Bun survives, the container exits (correct), but the health check at `/healthz` was served by Caddy, not Bun -- meaning internal API health is not checked

### Helm Chart (charts/agentpane/)

**Architecture:** Full Helm chart with PostgreSQL subchart (Bitnami), Gateway API support, OpenShift compatibility, and comprehensive sandbox RBAC.

**Strengths:**
- PostgreSQL subchart with `existingSecret` support for production credential management
- Sandbox isolation: dedicated namespace, NetworkPolicy (deny-all default + selective egress), ResourceQuota, LimitRange
- Pod security: `runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities: drop: [ALL]`, `seccompProfile: RuntimeDefault`
- Pod Security Standards enforced at namespace level (`pod-security.kubernetes.io/enforce: restricted`)
- Config/secret checksum annotations for rollout on config changes
- HPA support (disabled by default)
- Gateway API HTTPRoute + OpenShift Route support
- OpenShift SCC templates for restricted environments
- Helm test for connectivity verification
- Proxy/egress configuration for private networks
- Topology spread constraints support

**Concerns:**
1. **Chart version is `0.1.0` with `appVersion: "1.0.0"`** -- no versioning automation, chart version and app version are static
2. **Image repository `agentpane/agentpane`** is a placeholder -- no actual registry exists
3. **No PDB (PodDisruptionBudget)** template -- upgrades could cause downtime
4. **Data volume uses `emptyDir`** in the deployment (line 135-136: `volumes: - name: data, emptyDir: {}`). This means all application data is lost on pod restart. This is acceptable if PostgreSQL is the database (data lives in PG), but if someone deploys with SQLite mode somehow, data would be ephemeral.
5. **No init container for database migrations** -- migrations run at app startup which can cause issues with rolling updates (multiple pods trying to migrate simultaneously)
6. **No Deployment strategy specified** (defaults to RollingUpdate). For a stateful app with SQLite, `Recreate` would be safer. For PostgreSQL mode, RollingUpdate is fine but needs migration sequencing.
7. **Service port 3001** maps directly to the API server, bypassing Caddy/durable-streams entirely. The K8s deployment has no durable-streams capability unless an external durable-streams server is deployed separately.

### K8s Manifests (k8s/manifests/)

Standalone manifests exist for sandbox infrastructure:
- `crds.yaml` -- Agent Sandbox CRD definitions (Sandbox, SandboxTemplate, SandboxWarmPool, SandboxClaim)
- `agentpane-sandbox-template.yaml` -- default sandbox pod template
- `agentpane-warm-pool.yaml` -- warm pool configuration
- `namespace.yaml`, `limit-range.yaml` -- sandbox namespace setup
- `runtime-class-gvisor.yaml` -- gVisor runtime class for enhanced isolation

These are well-structured for the sandbox use case but are applied manually (`kubectl apply -f`), not managed by the Helm chart lifecycle.

### Caddyfile

**Strengths:**
- Admin interface disabled (`admin off`)
- Auto-HTTPS disabled (appropriate for container-internal use)
- Gzip + Brotli compression for static files
- Immutable cache headers for hashed assets (`/assets/*`)
- SPA fallback (`try_files {path} /index.html`)
- Flush interval -1 for SSE streaming support
- Durable streams integrated directly into Caddy

**Concerns:**
- Stream endpoints have **no authentication** at the Caddy level (documented, relying on network-level isolation). In a K8s environment where the pod is directly exposed, this could be a gap.
- No rate limiting configured
- No security headers (HSTS, CSP, X-Frame-Options, etc.)
- No access logging configured

---

## Missing CD Pipeline

### What Does Not Exist

1. **No container image build/push workflow** -- There is no GitHub Actions workflow that builds the Docker image and pushes it to a registry (GHCR, ECR, DockerHub, etc.)
2. **No release workflow** -- No automated creation of GitHub Releases, tags, or release notes
3. **No deployment trigger** -- No workflow that deploys to staging or production (via Helm upgrade, ArgoCD sync, kubectl, etc.)
4. **No environment promotion** -- No mechanism to promote a build from staging to production
5. **No canary/blue-green deployment support** -- The Helm chart does not include Argo Rollouts, Flagger, or similar progressive delivery tools
6. **No smoke test post-deploy** -- No workflow step that verifies the deployment is healthy after release

### Recommended CD Pipeline

```
PR merge to main
  -> Build Docker image (multi-arch)
  -> Scan image (Trivy/Grype)
  -> Push to registry with git SHA + "latest" tags
  -> Deploy to staging (Helm upgrade or ArgoCD sync)
  -> Run smoke tests against staging
  -> Manual approval gate
  -> Deploy to production
  -> Post-deploy health check
```

---

## Release Process Gaps

### Versioning

- **package.json version:** Hardcoded at `1.0.0`, never updated
- **Chart.yaml version:** `0.1.0` (chart) / `1.0.0` (app) -- static, never bumped
- **No git tags exist** (confirmed via `git tag -l` returning empty)
- **No CHANGELOG** in the project root (only in node_modules)
- **No semantic versioning automation** (no conventional-commits, no release-please, no semantic-release)

### What's Needed

1. **Version bumping strategy:** Choose between semantic-release (fully automated) or Changesets (PR-based) or release-please (commit-message-based)
2. **Changelog generation:** Automated from conventional commits or manually maintained
3. **Git tagging:** Automated tag creation on release (e.g., `v1.2.3`)
4. **Container image tagging:** Tags should include git SHA, semver, and `latest`
5. **Helm chart versioning:** Chart version should track independently from app version, both auto-bumped
6. **Rollback procedure:** Currently undefined. Need documented rollback via `helm rollback` or previous image tag

---

## Environment Management

### Current State

- **Single `.env` file** at project root -- contains only a comment (`# AgentPane Environment`), effectively empty
- **No `.env.example`** file to document required/optional variables
- **No staging vs production configuration separation**
- **No environment-specific values files** for Helm (e.g., `values-staging.yaml`, `values-production.yaml`)
- Docker compose uses environment variable passthrough (`${ANTHROPIC_API_KEY:-}`) which is good

### Environment Variables in Use

From analysis of `docker-compose.yml`, `Dockerfile`, Helm `values.yaml`, and server config:

| Variable | Where Set | Required? |
|----------|-----------|-----------|
| `NODE_ENV` | Dockerfile, Helm | Yes (default: production) |
| `DB_PATH` | Dockerfile | SQLite mode only |
| `DB_MODE` | Helm ConfigMap | Yes (sqlite or postgres) |
| `DATABASE_URL` | Helm Secret | PostgreSQL mode only |
| `ANTHROPIC_API_KEY` | Docker Compose, Helm Secret | Yes (for agent execution) |
| `CLAUDE_OAUTH_TOKEN` | Docker Compose, Helm Secret | Alternative to API key |
| `STREAMS_DATA_DIR` | Docker Compose | Caddy durable-streams path |
| `CADDY_STREAMS_URL` | Docker Compose | Durable streams URL |
| `LOG_LEVEL` | Docker Compose, Helm ConfigMap | No (default: info) |
| `CORS_ORIGIN` | Helm ConfigMap | Production yes |
| `GITHUB_*` | Helm ConfigMap + Secret | If GitHub integration enabled |
| `HTTPS_PROXY` / `NO_PROXY` | Helm env | If behind proxy |

### What's Needed

1. `.env.example` documenting all variables with descriptions
2. Environment-specific Helm values files (`values-staging.yaml`, `values-production.yaml`)
3. Secret management integration (External Secrets Operator, Vault, AWS Secrets Manager)
4. Environment parity documentation

---

## Database Migration Strategy

### SQLite Migrations (Default Mode)

**Mechanism:** Custom migration runner at `src/lib/bootstrap/migrations/runner.ts`

- Uses a `schema_migrations` tracking table with version numbers
- 23 migrations defined in `src/lib/bootstrap/migrations/index.ts` (version 1 through 23)
- Migrations run **on application startup** (in `src/db/client.ts` and `src/server/bootstrap/phases/database.ts`)
- Idempotent: `CREATE TABLE IF NOT EXISTS`, ALTER TABLE failures for duplicate columns are caught
- Forward-only: no rollback/down migrations

**Strengths:**
- Simple and reliable for single-instance SQLite deployments
- Tracked via version numbers, no re-application risk
- Schema drift detection between SQLite and PostgreSQL in CI

**Concerns:**
- No rollback capability -- forward-only migrations
- No dry-run or validation mode
- Multiple instances starting simultaneously could race on migration (mitigated by SQLite's write lock, but not ideal)

### PostgreSQL Migrations (Helm/K8s Mode)

**Mechanism:** Drizzle Kit migrator (`drizzle-orm/postgres-js/migrator`)

- Migration files in `src/db/migrations-pg/` (4 migration files: 0000 through 0003)
- Runs via `migratePg()` at application startup in `src/server/bootstrap/phases/database.ts`
- Generated by `drizzle-kit generate --config=drizzle.config.pg.ts`

**Concerns:**
1. **PostgreSQL migrations lag behind SQLite** -- SQLite has 23 versions, PostgreSQL has 4. This means PostgreSQL schema is potentially out of sync with the latest SQLite schema. The schema drift check only verifies export lists, not actual migration content.
2. **No init container for migrations** -- In K8s with multiple replicas, all pods will attempt to run migrations simultaneously on startup. Drizzle Kit's migrator may handle this via advisory locks, but this is fragile.
3. **No migration testing** -- CI does not run migrations against a real PostgreSQL instance
4. **No manual migration command** -- The `docker/start.sh` does not run migrations; they only run when the Bun server initializes
5. **Migration path from SQLite to PostgreSQL** exists (`scripts/migrate-sqlite-to-pg.ts`) but is a manual script

### Recommended Migration Architecture

For K8s deployments:
1. **Helm pre-upgrade hook** (Job) that runs migrations before the deployment rolls out
2. **Migration locking** via PostgreSQL advisory locks (Drizzle Kit may handle this, but should be verified)
3. **PostgreSQL migration parity** -- ensure PG migrations match SQLite schema
4. **Backup before migrate** -- automated PG dump before migration runs

---

## Container Security Assessment

### Docker Image

| Control | Status | Notes |
|---------|--------|-------|
| Non-root user | Yes | Runs as `bun` user |
| Read-only root filesystem | Not enforced | Not set in Dockerfile |
| Minimal base image | Partial | `oven/bun:1.3.10-alpine` is small but includes full Bun runtime |
| No secrets in image | Yes | Secrets passed via environment variables |
| HEALTHCHECK | Yes | wget-based health probe |
| Signal handling | Yes | tini as PID 1 |
| Capability dropping | Not in Dockerfile | Done at Helm/K8s level |
| Image scanning | No | No Trivy/Grype in CI |

### Helm/K8s

| Control | Status | Notes |
|---------|--------|-------|
| Non-root | Yes | `runAsNonRoot: true`, UID 1000 |
| Read-only rootfs | Yes | `readOnlyRootFilesystem: true` with tmp/data emptyDirs |
| Drop ALL capabilities | Yes | `capabilities: drop: [ALL]` |
| Seccomp | Yes | `RuntimeDefault` profile |
| No privilege escalation | Yes | `allowPrivilegeEscalation: false` |
| Pod Security Standards | Yes | `restricted` enforced on sandbox namespace |
| Network policies | Yes | Sandbox namespace: deny-all + selective egress |
| Resource limits | Yes | CPU/memory limits defined |
| Service account | Yes | Created with minimal permissions |

### Agent Sandbox Image

| Control | Status | Notes |
|---------|--------|-------|
| Non-root | Yes | Runs as `node` user |
| Minimal sudo | Yes | Only `/bin/chown` permitted |
| Git safe.directory | Yes | Configured for mounted volumes |
| Base image | Concern | Uses `srlynch1/terraform-ai-tools:latest` -- personal DockerHub, not pinned |
| Claude Code CLI | Concern | `npm install -g @anthropic-ai/claude-code` installed at build time, not version-pinned |

---

## Recommendations

### Priority 1: Critical for Production (1-2 weeks)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | **Add CD workflow for Docker image build/push** -- GitHub Actions workflow triggered on main merge that builds multi-arch image, scans with Trivy, pushes to GHCR with git SHA + semver tags | 2-3 days | Unblocks all deployment automation |
| 2 | **Add PodDisruptionBudget** to Helm chart | 1 hour | Prevents downtime during voluntary disruptions |
| 3 | **Add Helm pre-upgrade hook for database migrations** -- Run migrations in a Job before deployment rollout to prevent concurrent migration races | 1 day | Required for multi-replica PostgreSQL deployments |
| 4 | **Resolve PostgreSQL migration lag** -- Generate/verify PG migrations for all 23 SQLite migration versions to achieve schema parity | 2-3 days | PostgreSQL deployments may have missing tables/columns |
| 5 | **Create `.env.example`** with all environment variables documented | 2 hours | Developer onboarding, deployment documentation |
| 6 | **Pin base image for agent-sandbox** -- Replace `srlynch1/terraform-ai-tools:latest` with a versioned, org-owned image | 1 day | Supply chain security |

### Priority 2: Important for Operations (2-4 weeks)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 7 | **Add release automation** (semantic-release or release-please) -- Automate version bumping, changelog generation, git tagging, and GitHub Releases | 2-3 days | Traceability, professional release process |
| 8 | **Add container image scanning to CI** -- Trivy or Grype scan of built Docker images with severity thresholds | 1 day | Security compliance |
| 9 | **Add Caddyfile security headers** -- HSTS, CSP, X-Content-Type-Options, X-Frame-Options | 2 hours | Web security baseline |
| 10 | **Create environment-specific Helm values** -- `values-staging.yaml` and `values-production.yaml` with appropriate resource/replica/log settings | 1 day | Environment consistency |
| 11 | **Add Deployment strategy configuration** to Helm chart -- `Recreate` for SQLite, `RollingUpdate` with `maxUnavailable: 0` for PostgreSQL mode | 2 hours | Zero-downtime deployments |
| 12 | **Separate Caddy from app container in K8s** -- Run durable-streams-server as a sidecar container or separate deployment to match Docker architecture parity | 2-3 days | Feature parity between Docker and K8s deployments (durable streams missing in K8s) |

### Priority 3: Good Practice (1-2 months)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 13 | **Add smoke/E2E tests post-deploy** -- Health check, basic API call, agent creation in staging after deploy | 2-3 days | Deployment confidence |
| 14 | **Implement GitOps** (ArgoCD or Flux) for declarative deployments | 3-5 days | Auditable, git-driven deployments |
| 15 | **Add database backup/restore automation** -- Pre-migration PG dump, scheduled backups via CronJob | 2 days | Disaster recovery |
| 16 | **Remove source code from production image** -- Pre-compile TypeScript or bundle with Bun, remove `src/` from runtime stage | 2-3 days | Smaller image, reduced attack surface |
| 17 | **Add rate limiting to Caddyfile** -- Protect public endpoints from abuse | 1 day | DoS protection |
| 18 | **Add Prometheus metrics endpoint** -- `/api/metrics` with request counts, latencies, agent execution stats | 2-3 days | Observability |
| 19 | **Add rollback documentation** -- Document `helm rollback`, database migration rollback procedures, and image revert process | 1 day | Operational runbook |
| 20 | **Implement progressive delivery** -- Canary or blue-green deployments via Argo Rollouts or Flagger | 3-5 days | Safe production deployments |

---

## Summary

The project has strong CI foundations (testing, linting, SAST, schema drift detection) and a well-designed Helm chart with excellent security posture (restricted PSS, NetworkPolicy, drop-all capabilities). However, the **complete absence of CD automation** (no image build/push, no release workflow, no deployment pipeline) is the primary blocker for production readiness. The PostgreSQL migration gap and the architectural divergence between Docker (Caddy + Bun) and K8s (Bun only, no durable streams) are the next most critical issues to resolve.
