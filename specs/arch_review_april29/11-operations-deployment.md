# 11 — Operations & Deployment (April 29 Review)

## Summary

PR #176 (theme-11 remediation) and the dependency-bump PRs that followed (#180–#189) materially closed the largest gaps from the April 20 review. There is now a real CD pipeline at `.github/workflows/release.yml` (multi-arch GHCR push, Trivy gate, SBOM + provenance attestations, Helm chart packaging, GitHub Release asset upload). `.github/workflows/publish-cli-monitor.yml` replaces the manual npm publish, with `--provenance` attestations. The Helm chart gained a `pre-install,pre-upgrade` migration Job (`charts/agentpane/templates/migration-job.yaml`), an optional PVC, a guarded PDB, an explicit `RollingUpdate` strategy, a `terminationGracePeriodSeconds: 60`, and durable-streams sidecar topology parity with Compose. The shutdown sequence at `src/server/bootstrap/phases/agent-shutdown.ts` now flushes running agents and best-effort stops sandboxes inside a 10s budget. PG migration parity is enforced by `scripts/check-migration-parity.ts` (12 PG migrations vs 18 SQLite, with allowlist + name-suffix matching).

What is **not yet fixed**: agent-runner ships **two competing lockfiles** in git (`agent-runner/bun.lock` 76 KB, last touched April 20; `agent-runner/package-lock.json` 13 KB, last touched February 12 — drifted by 67 days), and the Dockerfiles use `npm install --ignore-scripts` against the stale npm lockfile while CI uses `bun install --frozen-lockfile` against the bun lockfile. This is exactly the lockfile drift bug that bit theme-11 and it remains live. The agent-sandbox base (`srlynch1/terraform-ai-tools:latest`) and a global `npm install -g @anthropic-ai/claude-code` (no version pin) both ship at build time. The agent-sandbox image and the AgentCore image are NOT built or pushed by `release.yml` — only the main app image is. There is still no CronJob that runs `backup-db-pg.sh`, no documented restore drill, no `.env.example`, and the `prepare` script still echoes a reminder rather than installing pre-commit hooks. The Helm `restartPolicy` for the migration Job is `OnFailure` with `backoffLimit: 2` but no readiness gate ensuring the app `migrate-check-only` actually runs before serving traffic.

No P0 — production isn't blocking. P1 cluster: lockfile drift in `agent-runner/`, agent-sandbox/AgentCore images outside the release pipeline, no startup migration verification, missing CRDs prerequisite documentation, no rollback runbook tied to image digests. P2 cluster: backup CronJob, `.env.example`, `prepare` hook installer, scheduled WARNING semgrep report, agent-runner production-only `npm install` (no `--omit=dev` analog).

## Map

| Layer | Files | Purpose |
|-------|-------|---------|
| CI workflow | `.github/workflows/ci.yml` (223 lines), `.github/actions/setup-bun-env/action.yml` | install -> {build, lint-and-typecheck, test[1/3..3/3], semgrep, e2e-smoke, coverage} -> integration-test[1/2..2/2]; concurrency cancel; `CACHE_VERSION: v2` |
| Release workflow | `.github/workflows/release.yml` (192 lines) | Tag-triggered: build-and-push (multi-arch GHCR, Trivy CRITICAL/HIGH gate, SBOM, provenance) -> package-helm-chart -> create-release |
| CLI monitor publish | `.github/workflows/publish-cli-monitor.yml` (78 lines) | `cli-monitor-v*` tag or `workflow_dispatch`; npm publish with `--provenance` |
| Mutation testing | `.github/workflows/mutation-testing.yml` (98 lines) | PR-gated for state-machines + rbac; cron-only for orchestration |
| Dockerfiles | `docker/Dockerfile` (82 lines), `docker/Dockerfile.agent-sandbox` (104 lines), `docker/Dockerfile.agentcore` (104 lines) | App image (Bun 1.3.10-alpine, multi-stage), sandbox image (Debian-based via terraform-ai-tools), AgentCore (node:22-bookworm-slim ARM64) |
| Compose | `docker/docker-compose.yml`, `docker/docker-compose.postgres.yml`, `docker/docker-compose.memory.yml` | Dev/demo only; postgres password hardcoded `agentpane_dev` |
| Helm chart | `charts/agentpane/Chart.yaml` (`version: 0.1.0, appVersion: 1.0.0`), `values.yaml` (516 lines), 21 templates incl. `migration-job.yaml`, `pvc.yaml`, `poddisruptionbudget.yaml`, `scc.yaml`, `sandbox-rbac.yaml` | Production deploy unit; Bitnami PG subchart (`charts/agentpane/charts/postgresql-18.3.0.tgz`) |
| K8s manifests (out-of-Helm) | `k8s/manifests/{crds,agentpane-sandbox-template,agentpane-warm-pool,namespace,limit-range,runtime-class-gvisor}.yaml` | Sandbox CRDs + warm pool; applied manually before `helm install` |
| Migration scripts | `scripts/migrate-run-only.ts`, `scripts/migrate-check-only.ts`, `scripts/check-migration-parity.ts`, `scripts/check-schema-drift.ts` | Out-of-band runner, read-only verifier, SQLite/PG parity check |
| Backup scripts | `scripts/backup-db.sh` (SQLite, 46 lines), `scripts/backup-db-pg.sh` (PG, 57 lines) | Manual; cron-ready; not invoked by anything |
| agent-runner | `agent-runner/package.json`, `agent-runner/bun.lock` (567 lines, Apr 20), `agent-runner/package-lock.json` (419 lines, Feb 12) | Two lockfiles tracked in git; build/runtime use **different** managers |
| cli-monitor | `packages/cli-monitor/package.json` (`v0.2.1`), `bun.lock` (28 lines) | Single lockfile; bun-based; published to npm |

## What's working

- `release.yml` is comprehensive: `actions/checkout@v6`, `docker/setup-qemu-action@v4`, `docker/setup-buildx-action@v3`, `docker/build-push-action@v6` with `provenance: true` and `sbom: true`, `aquasecurity/trivy-action@0.30.0` with `severity: CRITICAL,HIGH` `exit-code: '1'` `ignore-unfixed: true`, `softprops/action-gh-release@v3` with `generate_release_notes: true`. All actions pinned to major versions (Dependabot is keeping these current — see #180–#189).
- `publish-cli-monitor.yml` declares `permissions.id-token: write` for npm OIDC provenance — the right pattern.
- `Dockerfile` uses pinned `oven/bun:1.3.10-alpine` for all three stages and `alpine:3.21` for the Caddy fetch stage. The `durable-streams-server` binary is fetched from a pinned upstream version (`v0.2.1`) via `ADD` (Docker verifies the URL but not a checksum — see F11-15).
- `Dockerfile` runtime stage runs as `USER bun`, uses `tini` as PID 1, and exposes a `HEALTHCHECK` against `/healthz`.
- Helm `securityContext` blocks set `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, drop ALL capabilities, and `seccompProfile: RuntimeDefault` (`charts/agentpane/values.yaml:158-166`). The sandbox namespace has Pod Security Standard `restricted` enforced (`sandbox-namespace.yaml:9-11`).
- `migration-job.yaml` annotates `helm.sh/hook: pre-install,pre-upgrade`, `hook-weight: -5`, `hook-delete-policy: before-hook-creation,hook-succeeded` — Helm correctly waits for migration Job completion before rolling out the Deployment.
- `poddisruptionbudget.yaml:9-13` skips PDB rendering when `replicaCount=1` (or autoscaling.minReplicas=1) to avoid the unkillable-pod gotcha. This was a real risk in the April 20 review and the fix is well-considered.
- `agent-shutdown.ts` runs first (LIFO last-registered) and stays inside a 10s budget so the 30s force-exit always fires; it publishes `agent:interrupted` events with `Promise.allSettled` per-event timeouts so a wedged stream doesn't block.
- `scripts/check-audit.ts` gates `npm audit` with a per-(GHSA, package) allowlist that has expiry dates — better than `--audit-level=critical` alone.
- `backup-db-pg.sh` uses `pg_dump --dbname=` (resists flag injection), `umask 077`, `pg_restore --list` verification, atomic-on-failure trap.

## Findings

### F11-15: agent-runner ships two competing lockfiles in git, and Dockerfiles use the stale one

- **Priority**: P1 — **Size**: M
- **Observation**: `git ls-files agent-runner/` returns BOTH `agent-runner/bun.lock` AND `agent-runner/package-lock.json`. Mtimes diverge by 67 days: the bun lockfile was last touched 2026-04-20 (76,248 bytes) while the npm lockfile is from 2026-02-12 (13,745 bytes). CI in `.github/workflows/ci.yml:113` runs `cd agent-runner && bun install --frozen-lockfile`, so the bun lockfile is what CI verifies. But three Dockerfiles install via npm against the stale lockfile:
  - `docker/Dockerfile:18` — `RUN cd agent-runner && npm install --ignore-scripts`
  - `docker/Dockerfile.agent-sandbox:53` — `RUN npm install --ignore-scripts`
  - `docker/Dockerfile.agentcore:28` — `RUN npm install --ignore-scripts`

  None of these uses `--frozen-lockfile`/`npm ci`, so each build silently regenerates `package-lock.json` from `package.json` semver ranges, picking whatever transitive versions npm chooses today. CLAUDE.md still references "agent-runner Lockfile" with the stanza "After modifying `agent-runner/package.json` or its dependencies, regenerate the lockfile: `cd agent-runner && bun install && cd ..`. CI uses `--frozen-lockfile`" — true for CI, but image builds bypass it. `.github/workflows/build` (`ci.yml:101-117`) only verifies the bun side.
- **Risk**: This is the exact lockfile-drift bug that prompted the April PR #161 fix. Production images and CI test against different dependency graphs. A transitive CVE patch landing in the bun lockfile won't reach the image. Reproducibility is impossible — yesterday's `docker build` and tomorrow's `docker build` resolve different transitives.
- **Recommendation**: Pick one manager and delete the other lockfile. If keeping bun (matches the rest of the repo): change all three `RUN npm install --ignore-scripts` to `RUN bun install --frozen-lockfile --ignore-scripts` (Dockerfile already has `oven/bun:1.3.10-alpine`; agent-sandbox and agentcore base images need bun added). If keeping npm: switch CI to `npm ci`, remove `agent-runner/bun.lock`, and document the choice. Add a CI check that fails when both lockfiles exist: `test ! -f agent-runner/bun.lock || test ! -f agent-runner/package-lock.json`.

### F11-16: agent-sandbox and agentcore images are NOT built or pushed by the release pipeline

- **Priority**: P1 — **Size**: M
- **Observation**: `.github/workflows/release.yml:81-94` builds only `docker/Dockerfile` (the main app image). There is no job that builds `docker/Dockerfile.agent-sandbox` or `docker/Dockerfile.agentcore`. Theme-04 P0-01 closed the digest-pinning enforcement at runtime (`SANDBOX_DEFAULTS.image` requires `@sha256:`), but the upstream publishing path — which would produce the digest in the first place — does not exist in CI. The Dockerfile.agent-sandbox header at line 8 acknowledges this: "is currently a placeholder digest pending the GHCR publish workflow in theme 11." The placeholder is still there. `docker/build-agent-sandbox.sh` is a manual local script.
- **Risk**: Operators running the chart with `sandbox.image.repository: agentpane/agent-sandbox` will pull a stale tag that nobody is rebuilding. The agent-sandbox image is the actual security boundary the runtime enforces digest-pinning against — if it's never republished, the digest pin enforces a stale image with stale `@anthropic-ai/claude-code`, stale terraform-ai-tools base, stale OS packages. AgentCore deployments to AWS Bedrock have no automated build path at all.
- **Recommendation**: Extend `release.yml` with two parallel jobs: `build-and-push-sandbox` (linux/amd64,linux/arm64, target `ghcr.io/agentdevsl/agent-sandbox`) and `build-and-push-agentcore` (linux/arm64 only, target `ghcr.io/agentdevsl/agentpane-agentcore`). Both should run Trivy with the same gate. After push, capture the `digest` output and post a PR (using `peter-evans/create-pull-request`) that updates `SANDBOX_DEFAULTS.image` in `src/lib/sandbox/types.ts` to the new digest — automating what the Dockerfile.agent-sandbox header describes as a manual step. Add `BASE_IMAGE` digest pinning to the same PR (currently `srlynch1/terraform-ai-tools:latest` at `Dockerfile.agent-sandbox:23`).

### F11-17: Migration check on app startup is not actually wired up

- **Priority**: P1 — **Size**: S
- **Observation**: `scripts/migrate-check-only.ts` exists and the migration-job comment at `migration-job.yaml:9-11` says "App pods run `bun run migrate:check-only` as part of their startup (see the Deployment startupProbe / bootstrap flow) and refuse to serve if the schema is behind". Search results show the script is referenced ONLY in comments and `package.json:52` — it is not invoked in `docker/start.sh` (which runs `/usr/local/bin/durable-streams-server` then `bun src/server/api.ts`), not in `src/server/bootstrap/phases/database.ts`, and not as an initContainer in `deployment.yaml`. The startup probe (`values.yaml:339-346`) hits `/api/healthz` but `database.ts` still calls `migratePg()` / SQLite migrate at boot — so app pods will silently re-apply migrations from N replicas in parallel, defeating the point of the pre-upgrade Job.
- **Risk**: The `pre-upgrade` Job applies migrations once, then N app pods all call `migratePg()` again. Drizzle's advisory lock serialises but doesn't prevent retries; on a transient failure, one pod can race ahead of another. More importantly, the documented "refuse to start if schema is behind" safety net does not exist — a misconfigured `migrationJob.enabled: false` lets pods boot against an unmigrated DB.
- **Recommendation**: Either (a) call `migrate-check-only.ts` as an `initContainer` in `deployment.yaml` so the app container never starts on a stale schema, or (b) call it inline at the top of `database.ts` and skip `migratePg()` / SQLite migrate when `process.env.MIGRATIONS_PRE_APPLIED === 'true'` (set by the Job's success). Also delete the stale comment in `migration-job.yaml:9-11`. Update `scripts/migrate-check-only.ts:114` (`new BunSQLite(dbPath, { readonly: true })`) to handle a non-existent DB file gracefully when SQLite mode (currently throws).

### F11-18: agent-runner Dockerfile uses `npm install` (not `npm ci`), pulls dev deps, then prunes

- **Priority**: P1 — **Size**: S
- **Observation**: `docker/Dockerfile.agent-sandbox:53` and `docker/Dockerfile.agentcore:28` both run `RUN npm install --ignore-scripts`. This pulls all `devDependencies` (the agent-runner's `devDependencies` at `agent-runner/package.json:21-24` are `@types/node` and `typescript ^6.0.3`), runs `npm run build`, then prunes to production. The image build is therefore dependent on whatever `typescript@^6.x` resolves to at build time — not the locked version. There is no `--omit=dev` analog for the build stage to enforce. The same applies to `Dockerfile:18` (main app image) which runs `cd agent-runner && npm install --ignore-scripts` — combined with F11-15, this builds the agent-runner against a graph CI never tested.
- **Risk**: A breaking change in `typescript@^6` (or `@types/node`) silently lands in production; CI never sees it because CI uses bun. The same applies to runtime deps when their semver allows newer transitives.
- **Recommendation**: After resolving F11-15, replace all `RUN npm install --ignore-scripts` with `RUN npm ci --ignore-scripts` (npm) or `RUN bun install --frozen-lockfile --ignore-scripts` (bun). Add a multi-stage split so the build stage's deps don't ship — current Dockerfile.agent-sandbox does this with `npm prune --production` at line 60, but `npm ci` would be safer and faster (no resolver pass).

### F11-19: `@anthropic-ai/claude-code` global install has no version pin in any image

- **Priority**: P1 — **Size**: XS
- **Observation**: Three places install the Claude Code CLI globally with no version:
  - `docker/Dockerfile.agent-sandbox:41` — `RUN npm install -g @anthropic-ai/claude-code`
  - `docker/Dockerfile.agentcore:58` — `RUN npm install -g @anthropic-ai/claude-code`
  - (none in main `docker/Dockerfile` — the SDK ships via the bun-managed node_modules there.)
  Without a semver, every image rebuild pulls whatever is current on npm. The agent-sandbox image is the security boundary; the CLI it ships and the SDK in the agent-runner can drift.
- **Risk**: A surprise breaking change in the Claude Code CLI silently breaks all sandbox agents on the next image rebuild. Reproducibility of past builds is impossible — `docker run agentpane/agent-sandbox:v1.2.3` doesn't tell you which CLI version is inside.
- **Recommendation**: Pin to a semver: `RUN npm install -g @anthropic-ai/claude-code@<version>`. Add a Dependabot config block for the Dockerfiles so the pin gets bumped automatically. Capture the actual version in an `org.opencontainers.image.version` LABEL written by buildx from a `--build-arg`.

### F11-20: Helm chart sandbox image still uses `agentpane/agent-sandbox` placeholder, no digest

- **Priority**: P1 — **Size**: S
- **Observation**: `charts/agentpane/values.yaml:380-384` declares `sandbox.image.repository: agentpane/agent-sandbox` with `tag: ""`. The `_helpers.tpl:170-173` `agentpane.sandbox.image` template defaults the tag to `.Chart.AppVersion` (`1.0.0`). This produces `agentpane/agent-sandbox:1.0.0` — a tag-only reference on Docker Hub. The runtime path enforces digests (`isDigestPinnedImage()` rejects tag-only refs at the SandboxConfigService layer, per the April 20 review note), but the chart-level value is never read by that path; instead, the database setting is what gets used at runtime. So the chart's sandbox image config is decorative — and operators reading values.yaml would reasonably expect the chart's pin to govern. The chart README should at minimum tell them otherwise.
- **Risk**: Two sources of truth (chart values and DB setting) for the sandbox image, with the chart values never consulted at runtime. Operator confusion when they bump the tag in `values.yaml` and nothing happens.
- **Recommendation**: Either (a) wire `values.yaml:sandbox.image` through to the database via a chart `post-install` Job that writes `sandbox.kubernetes.image` setting, with the chart enforcing a digest in the Helm template (`fail` if the value lacks `@sha256:`), or (b) remove `sandbox.image` from `values.yaml` entirely and document that sandbox image config is DB-side only. Update the comment at `values.yaml:367-368` that promises image config via Settings UI to match.

### F11-21: No automated backup CronJob in Helm — backups exist in scripts only

- **Priority**: P1 — **Size**: M
- **Observation**: `scripts/backup-db-pg.sh` and `scripts/backup-db.sh` are well-written but only run when invoked manually. `grep -rn "CronJob" charts/` returns zero matches. `grep -rn "backup" charts/` returns zero matches. The Bitnami PostgreSQL subchart at `charts/agentpane/charts/postgresql-18.3.0.tgz` does ship a `volumePermissions` init and supports a backup sidecar, but neither is enabled in `values.yaml:496-516` (`postgresql:` block has only `persistence.enabled` and `resources` overrides). A fresh `helm install` produces a deployment with no backups. The April 20 review F11-10 flagged this; nothing has changed.
- **Risk**: A migration that corrupts data has no rollback artefact. The `pre-upgrade` migration Job (F11-05 resolution) actively makes this worse — migrations now apply atomically via Helm's hook ordering, but if migrate fails halfway through a multi-table change, the operator has no pre-migration snapshot to revert to.
- **Recommendation**: Add `charts/agentpane/templates/backup-cronjob.yaml` gated on `backup.enabled` (default false). Mount a separate `backup` PVC, run `bun scripts/backup-db-pg.sh /backups` on a configurable schedule (default `0 2 * * *`). Add a second Helm hook annotated `pre-upgrade,hook-weight: -10` (runs BEFORE the migration Job) that triggers a one-shot backup, so every release captures a known-good snapshot. Document restore in `specs/application/operations/deployment.md` (currently missing — the section at `deployment.md:1086-1115` is hypothetical pseudocode, not the real script).

### F11-22: Caddy front door binary fetched without checksum verification

- **Priority**: P2 — **Size**: S
- **Observation**: `docker/Dockerfile:36` uses `ADD https://github.com/anthropics/durable-streams/releases/download/v0.2.1/durable-streams-server_linux_${TARGETARCH} /usr/local/bin/durable-streams-server` followed by `chmod +x`. Docker `ADD` will redownload only if the URL is new (it checksums internally) but no SHA-256 is asserted against the binary contents. If the GitHub release asset is replaced (e.g. the release is overwritten upstream), the next image rebuild silently picks up new bytes. Note also: the URL pins to `v0.2.1`, but `package.json:99` lists `@durable-streams/server: 0.3.1` and `@durable-streams/state: 0.2.5` — the server-binary version and the npm SDK version may be deliberately decoupled, but it is not documented.
- **Risk**: Supply-chain — a compromised or tampered upstream release silently lands in every rebuild. Binary version drift between the Caddy front door and the SDK clients could cause subtle stream protocol mismatches.
- **Recommendation**: Add a checksum verification step. Replace `ADD <url> ...` with `RUN apk add --no-cache curl ca-certificates && curl -fsSL -o /usr/local/bin/durable-streams-server "<url>" && echo "${EXPECTED_SHA256}  /usr/local/bin/durable-streams-server" | sha256sum -c -` where `EXPECTED_SHA256` is a `--build-arg`. Document the version-skew policy between Caddy binary and npm SDK in `specs/application/operations/deployment.md`.

### F11-23: Release pipeline does not produce signed artifacts (cosign present in permissions only)

- **Priority**: P2 — **Size**: M
- **Observation**: `.github/workflows/release.yml:34` declares `id-token: write      # cosign / provenance (future)` but no cosign step exists in the workflow. `provenance: true` and `sbom: true` (lines 89-90) generate buildx attestations, which is a real win, but image signing (Sigstore cosign keyless via OIDC) and attestation verification on the consuming side are not wired up. The Helm chart is uploaded as a plain tarball asset; there is no `helm sign` / `helm verify` flow.
- **Risk**: A compromised GHCR account can push tagged images that pass Trivy and have valid build attestations (because attestations are generated by the build, not signed by an external root). Without cosign signature + verification policy, downstream consumers can't reject untrusted builds.
- **Recommendation**: Add `sigstore/cosign-installer@v3` and `cosign sign --yes ${IMAGE_REF}@${DIGEST}` after the Trivy step. For the Helm chart, use `helm package --sign --key <name> --keyring <path>` with an in-CI ephemeral PGP key, or switch to OCI chart hosting and use cosign there too. Document the verification command (`cosign verify` with the GitHub OIDC issuer + workflow regex) in the release notes template at `release.yml:176-191`.

### F11-24: `prepare` script still echoes a reminder, hooks are uninstalled by default

- **Priority**: P2 — **Size**: XS
- **Observation**: `package.json:55` is unchanged from the April 20 review: `"prepare": "echo 'Run: pre-commit install --hook-type pre-commit --hook-type pre-push'"`. Fresh clones still have no hooks. CLAUDE.md continues to claim "Pre-commit hooks (automatic)" — misleading. The Detect-Secrets hook in particular only fires for developers who manually ran `pre-commit install` after `bun install`.
- **Risk**: New contributors land secret-detection failures in CI that local hooks would have caught. Subtle drift in formatting and secrets policies between developers.
- **Recommendation**: Replace with `"prepare": "command -v pre-commit >/dev/null && pre-commit install --hook-type pre-commit --hook-type pre-push 2>/dev/null || echo '[setup] pre-commit not installed — run: pipx install pre-commit'"`. Update CLAUDE.md to the truthful "Pre-commit hooks (when installed)" framing. Consider migrating to husky + lint-staged + lefthook to drop the Python dependency entirely.

### F11-25: No `.env.example` — documented variables and chart-supported variables drift

- **Priority**: P2 — **Size**: S
- **Observation**: `find` from the repo root for `.env.example` returns zero results. The root `.env` exists with one line: `# AgentPane Environment`. The Helm chart `configmap.yaml:6-25` documents `DB_MODE`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGIN`, `ANTHROPIC_BASE_URL`, `AGENT_MAX_RUNTIME_MS`, `GITHUB_APP_ID`, `GITHUB_APP_NAME`, `GITHUB_CLIENT_ID`. The deployment.md spec at lines 605-635 documents `ANTHROPIC_API_KEY`, `DB_MODE`, `NODE_ENV`, `LOG_LEVEL`, `GITHUB_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_NAME`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `SKIP_AUTH`. The two lists differ on at least `ANTHROPIC_BASE_URL`, `AGENT_MAX_RUNTIME_MS`, `CORS_ORIGIN`. Compose passes `${ANTHROPIC_API_KEY:-}` (`docker/docker-compose.yml:23`) without surfacing it in any example file. Developers are guessing.
- **Risk**: Onboarding friction; production misconfiguration when a critical var is undocumented; secrets accidentally committed when a developer just adds them to a `.env` they think is gitignored but isn't (the `.gitignore` is empty for env patterns — no `.env.local` or `.env.production.local` is enumerated).
- **Recommendation**: Create `.env.example` enumerating every variable (sourced from the union of `configmap.yaml`, `deployment.yaml` env, `docker-compose.yml`, and `deployment.md` reference table). Add `.env`, `.env.*.local`, `.env.development.local`, `.env.production.local` to `.gitignore`. Add a CI step that fails when a `.env*` file is staged.

### F11-26: Docker Compose for Postgres ships with a hardcoded password

- **Priority**: P2 — **Size**: XS
- **Observation**: `docker/docker-compose.postgres.yml:14` sets `POSTGRES_PASSWORD: agentpane_dev` as a literal value. `package.json:53` exposes this as `npm run docker:pg`. The CLAUDE.md "Naming: Project → Codespace" section uses this DB for local development. While clearly dev-only, the password is also referenced in `deployment.md:354` as the connection string a developer would copy-paste — and from there into ad-hoc scripts.
- **Risk**: Developers connect over LAN with the assumption that "agentpane_dev" is local-only; a forwarded port plus a dotfile leak exposes the credential. The hardcoding teaches new contributors a bad pattern.
- **Recommendation**: Switch to `${POSTGRES_PASSWORD:-agentpane_dev}` so the env can override, and add a comment instructing developers to set a real value. Generate a random password into `.env.development.local` on first `npm run docker:pg` if no override is set.

### F11-27: Mutation testing workflow caches Stryker incremental data with a stale fallback key

- **Priority**: P3 — **Size**: XS
- **Observation**: `mutation-testing.yml:71-74` uses `restore-keys: stryker-incremental-${{ matrix.area }}-${{ github.base_ref || 'main' }}- / stryker-incremental-${{ matrix.area }}-main-`. The cache key includes a hash of `src/lib/state-machines/**` etc. — the same files for all three areas. So the `state-machines` area can pull a `rbac` cache (matching the area prefix would correctly scope, but the source-set hash is computed across all areas). Result: cache hits between mutations of unrelated files; results are noisy.
- **Risk**: False stability — Stryker thinks a previous run already mutated a file when in fact the prior run was for a different area. Mutation scores become non-deterministic.
- **Recommendation**: Scope the `hashFiles` per matrix.area: `state-machines` -> `hashFiles('src/lib/state-machines/**')`; `rbac` -> `hashFiles('src/services/rbac*.ts', 'src/lib/api/auth-middleware.ts', 'src/lib/api/rbac-middleware.ts')`; etc. Use `${{ matrix.area }}` as the discriminant to enforce area-isolated caches.

### F11-28: BUN_VERSION pinned to 1.3.10 in workflows but CLAUDE.md tech stack says 1.3.12

- **Priority**: P3 — **Size**: XS
- **Observation**: `.github/workflows/ci.yml:10`, `.github/workflows/mutation-testing.yml:24`, `.github/workflows/publish-cli-monitor.yml:48`, `.github/actions/setup-bun-env/action.yml:8`, and all three Dockerfiles pin `1.3.10`. CLAUDE.md "Use this tech stack" table line for Runtime says "Bun 1.3.12 / Node 24+". `specs/application/operations/deployment.md:11` says `1.3.10`. `deployment.md:563` says "Recommended `1.3.10`". The CLAUDE.md value is ahead of reality.
- **Risk**: Developer setup matches a Bun version CI doesn't test against. Node engines pin in agent-runner is `>=24.0.0` (matches), but `package.json:7` says `node: >=24.0.0` — local devs on Node 22 will silently appear to work until a v24-only API is invoked.
- **Recommendation**: Sync CLAUDE.md to the actual pinned `1.3.10`. If 1.3.12 is the intended target, bump all five locations together (workflows, action, Dockerfiles) and re-test. Keep a single source of truth — consider extracting `BUN_VERSION` to a top-level repo file (`.tool-versions` for asdf) and reading it everywhere.

### F11-29: No documented rollback runbook tied to image digests

- **Priority**: P3 — **Size**: S
- **Observation**: `release.yml:190-191` says "Use `helm rollback <release> <revision>` to revert to a previous chart revision." That's necessary but insufficient — `helm rollback` reverts the chart, but the image digest the previous chart pointed to may have been overwritten upstream (e.g. if someone re-pushed the same tag). The release notes don't capture the image digest in a structured way that an operator could pin against. `deployment.md:1244-1294` has a generic "Rollback Procedures" section that predates the CD pipeline; it talks about `docker images agentpane --format` and `kubectl rollout undo` but not GHCR pulls or Helm chart asset reversion.
- **Risk**: Incident response under time pressure — an operator runs `helm rollback`, the rollback succeeds, but the rolled-back chart points to `agentpane:v1.2.3` which has been re-pushed since release. Now they're running the buggy image under a "rolled back" label. No way to detect this without out-of-band digest comparison.
- **Recommendation**: Update `release.yml:176-191` to include the digest in the release body in a copy-pasteable form, e.g. `image: ghcr.io/agentdevsl/agentpane@sha256:xxx`. Add a runbook section to `specs/application/operations/deployment.md` covering: (1) `helm rollback <release> <revision>`, (2) verify image digest matches the GitHub Release with `kubectl get deployment agentpane -o jsonpath='{.spec.template.spec.containers[0].image}'`, (3) restore the latest pre-upgrade backup from the new backup CronJob (F11-21), (4) `kubectl rollout status` to verify. Cross-link from `release.yml`.

## Cross-links

- `specs/arch_review_april/11-operations-deployment.md` — the April 20 review; F11-01 through F11-08 are now resolved (theme 11 / pre-existing themes), F11-09 through F11-14 carry forward as F11-25 / F11-21 / F11-11 (Dependabot churn) / F11-12 / F11-24 / F11-29 here.
- `specs/arch_review_april29/02-data-layer.md` — should cross-link F11-17 (migration startup verification).
- `specs/arch_review_april29/04-sandbox-providers.md` — should cross-link F11-16 (agent-sandbox image publishing) and F11-19 (Claude Code CLI version pin).
- `specs/arch_review_april29/06-security.md` — should cross-link F11-22 (Caddy binary checksum), F11-23 (cosign / image signing), F11-26 (hardcoded dev password).
- `specs/application/operations/deployment.md` — needs updates to reflect the real CD pipeline, the migration Job topology, the rollback runbook (F11-29), and the backup story (F11-21).
- `CLAUDE.md` "agent-runner Lockfile" section — must be rewritten as part of F11-15 to reflect whichever lockfile policy is chosen.
