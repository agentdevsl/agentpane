# Arch Review — Sandbox Providers

Theme: Docker, Kubernetes (Agent Sandbox CRD), and Nomad drivers; provider parity; create/run/destroy lifecycle; crash-cleanup; stream-ID consistency for `sandbox:*` events; config validation; health and liveness checks. Also covers the lingering AgentCore/Bedrock fourth path, the sandbox image supply chain, and credential injection into containers.

Cross-references: `specs/sandbox/architecture/overview.md`, `specs/sandbox/architecture/isolation-layers.md`, `specs/sandbox/security/environment-variables.md`, `specs/sandbox/security/path-boundary.md`, `specs/diagrams/` (sandbox sequence), `specs/roadmap/phase2-sandbox-plugins.md` (future plan context only).

---

## P0 — Security / data loss

### P0-01 Container-escape blast radius hinges on one undocumented Docker image tag (`srlynch1/agent-sandbox:latest`) with no signature pinning, no scanning, and no reproducible build

`src/lib/sandbox/types.ts` (line 91) sets `SANDBOX_DEFAULTS.image` to `srlynch1/agent-sandbox:latest` — a mutable, username-scoped Docker Hub tag — and `src/services/sandbox-config.service.ts` allows any codespace to override the image string. `docker/Dockerfile.agent-sandbox` builds `FROM ${BASE_IMAGE}` with `BASE_IMAGE=srlynch1/terraform-ai-tools:latest` (two layers of mutable `:latest` tags), installs `@anthropic-ai/claude-code` unpinned via `npm install -g`, apt-installs `ripgrep`/`fd-find`/`tree` without version pinning, and ships with a sudo NOPASSWD rule for `chown`. Every sandbox (Docker, K8s, Nomad) pulls this same image. Nothing in the provider layer verifies image digest, signature (cosign/sigstore), or checksum of the agent-runner tarball before executing arbitrary tool calls from a planning model inside it. The Docker provider does use `CapDrop: ['ALL']` + `no-new-privileges` + a narrow `CapAdd` list (`docker-provider.ts:571-574`), which is good — but those hardening flags only matter if the image itself is trustworthy. If a malicious image is pushed to the `srlynch1/*` namespace (compromised account, typo-squat, pull-through cache poisoning) the compromise lands in every tenant's sandbox with network egress enabled (`NetworkMode: 'bridge'` default) and the OAuth credentials file injected on first exec.

Direction: (1) pin `SANDBOX_DEFAULTS.image` to a digest (`srlynch1/agent-sandbox@sha256:...`), and require digest pinning for any tenant override. (2) Run Trivy/Grype in CI on `docker/Dockerfile.agent-sandbox` builds and fail the build on HIGH/CRITICAL findings. (3) Sign images with cosign keyless and verify on pull in the provider (`isImageAvailable` can also check the signature). (4) Remove the NOPASSWD sudo rule from `docker/entrypoint.sh` once the workspace-chown path has a root-owned alternative (K8s initContainer pattern is already the right shape — apply it to Docker too). (5) Document who owns the `srlynch1/*` namespace and what rotation policy it has — this is a single-person Docker Hub account footprint for what is effectively the tenant isolation boundary. Link to `specs/sandbox/security/environment-variables.md` and to the supply-chain section of `01-security-and-auth.md`.

---

## P1 — Silent failure / scaling wall

### P1-01 The `SandboxProvider` interface is not actually uniform — AgentCore is a fourth execution path that doesn't implement it, and the three CRD-style providers diverge on key contracts

`sandbox-provider.ts:124-167` defines `SandboxProvider` with `create/get/getById/list/pullImage/isImageAvailable/healthCheck/cleanup`. `DockerProvider`, `AgentSandboxProvider`, and `NomadSandboxProvider` all implement `EventEmittingSandboxProvider`, but:
- `AgentCoreSandboxProvider` deliberately does NOT implement the interface (`agentcore-sandbox-provider.ts:10-12` comment: "does NOT implement the full SandboxProvider interface"). It has a different `create(codespaceId, sandboxId)` signature, synchronous return, no `EventEmittingSandboxProvider`, no `cleanup(options)` shape, and no `list(): Promise<SandboxInfo[]>` (returns `AgentCoreRuntimeInfo[]`). The orchestrator (`container-agent.service.ts:146-166`) branches on `isAgentCoreProvider()` at every call site. Every feature added to the three "real" providers has to be double-implemented or ignored for AgentCore.
- `NomadSandboxInstance.execAsRoot()` throws (`nomad-sandbox-instance.ts:111-116`); `AgentSandboxInstance.execAsRoot()` silently falls back to non-root exec with a `log.warn` (`agent-sandbox-instance.ts:72-78`); `DockerSandbox.execAsRoot()` actually runs as root. Three different semantics for the same method — calling code cannot rely on the contract.
- Error shapes differ: Docker throws `SandboxErrors.*`, K8s throws `K8sErrors.*`, Nomad throws `NomadErrors.*`. Upstream handlers in `src/services/sandbox.service.ts` and `container-exec.service.ts` cannot do structured error handling without sniffing the discriminated union.
- `NomadSandboxProvider.list()` throws on failure (`nomad-sandbox-provider.ts:422-428`); `AgentSandboxProvider.list()` swallows and returns `[]` (`agent-sandbox-provider.ts:354-359`); `DockerProvider.list()` calls `validateContainers()` first and always returns an array. A UI component that expects consistent behaviour will silently show "no sandboxes" under K8s but surface errors under Nomad.

Direction: promote the interface to a real contract. Pick one behaviour for each method (recommend: `list()` returns `{ ok, data }` or throws a typed `ProviderError`; `execAsRoot()` either works or throws a single `RootExecNotSupported` error). Collapse error types to a single `SandboxProviderError` discriminated union, or make all three provider-specific errors extend a common base the service layer can pattern-match on. For AgentCore: either write a thin adapter that satisfies `SandboxProvider` (exec can be a no-op that throws `EXEC_NOT_SUPPORTED`) or remove AgentCore entirely (see P1-02).

### P1-02 AgentCore is half-deleted — migration 0011 dropped the DB columns but ~1200 LOC of provider/instance/bridge/errors code remains reachable, and the health path uses a dynamic-import AWS SDK that is never declared as a dependency

Migrations `0010_add_agentcore_columns.sql` and `0011_drop_agentcore_columns.sql` indicate AgentCore was removed from the schema. But `createAgentCoreProvider()` is still invoked from `container-agent.service.ts:154` via `setAgentCoreProvider(config)`, `agentcore-sandbox-instance.ts` still ships a hand-rolled AWS SigV4 signer (`agentcore-sandbox-instance.ts:57-156`), and `agentcore-sandbox-provider.ts:247-337` dynamically imports `@aws-sdk/client-sts` at health-check time via a string module name specifically so TypeScript won't resolve it statically. That package is not declared in `package.json` (grep confirms only the `sts` reference is a dynamic import with `webpackIgnore`). Result: health-check will throw at runtime in any deployment that didn't happen to have `@aws-sdk/client-sts` installed transitively. The hand-rolled SigV4 signer is explicitly flagged `SC-038` as "DEFERRED" in the code — meaning the team knows it's a maintenance liability. Meanwhile every new feature (stream-ID consistency, recovery, health-check shape) has to be considered against this fourth path too, and the tests mock it (`container-agent.service.test.ts:82`), so nobody notices when it drifts.

Direction: either (a) remove AgentCore completely — delete the provider/instance/bridge/tests/errors, drop the migrations comment trail, and simplify `container-agent.service.ts` to a single path; or (b) commit to it and add `@aws-sdk/client-sts` + `@aws-sdk/client-bedrock-agentcore` as real dependencies, replace the hand-rolled signer, and bring AgentCore under the `SandboxProvider` interface. Given the rest of the codebase targets Docker/K8s/Nomad, option (a) is the lower-risk move. Link to `specs/archive/` once removed.

### P1-03 Provider cleanup of orphans only exists for Docker — Kubernetes pods/PVCs and Nomad jobs have no startup-sweep, so a crash leaves cluster-side resources running forever

`DockerProvider.recover()` (`docker-provider.ts:432-527`) scans for `agentpane-*` containers, removes stopped/stale-image ones, re-registers running ones into the in-memory map. It's wired in at `src/server/bootstrap/sandbox/docker-init.ts:31`. Nothing equivalent exists for K8s or Nomad:
- `AgentSandboxProvider` has `validateSandboxes()` but only iterates `this.sandboxes` (the in-memory map); on a fresh process the map is empty, so orphaned `Sandbox` CRDs from a previous instance sit in the cluster consuming resources until their `shutdownTime` expires. `agentpane.io/sandbox-id` labels make them findable but no startup code does the sweep.
- `NomadSandboxProvider` has the same `validateSandboxes()` pattern and the same gap. Orphaned Nomad jobs stay alive indefinitely because `shutdownTime` is not set on Nomad jobs (only on K8s CRDs via `builder.shutdownTime()`).
- `AgentCoreSandboxProvider.cleanup()` only walks the in-memory `instances` map — same issue.

A server crash mid-create in K8s is the worst case: `client.createSandbox()` succeeded, `waitForReady()` threw, the provider emitted `sandbox:error` and the CRD is still in the cluster with no in-memory handle. The rescheduled agent on the next server boot creates a *second* CRD (`POD_ALREADY_EXISTS` guard only checks memory, see P1-04), doubling resource consumption until both expire.

Direction: add `recover()` to all three providers. For K8s: on bootstrap, list `Sandbox` CRDs in the namespace with `labelSelector: 'agentpane.io/sandbox-id'`, cross-reference with `sandboxInstances` table, and either re-register (if DB knows about them) or delete (if DB has no record or status is `stopped`). For Nomad: list jobs with `NOMAD_JOB_PREFIX`, same cross-reference. Wire each into the bootstrap phase alongside `docker-init.ts`. Add an integration test that simulates a mid-create crash and verifies the next boot cleans up. Link to `specs/operations/monitoring.md`.

### P1-04 `POD_ALREADY_EXISTS` / `JOB_ALREADY_EXISTS` guards check only in-memory state, so a server restart with a still-running K8s/Nomad sandbox creates a duplicate

`AgentSandboxProvider.create()` (`agent-sandbox-provider.ts:125-137`) and `NomadSandboxProvider.create()` (`nomad-sandbox-provider.ts:130-143`) both check `this.codespaceToSandbox.get(config.codespaceId)` and `this.creatingCodespaces.has(...)`. Both maps are in-memory only. After a process restart the maps are empty, so the next `create` for that codespace succeeds and provisions a second pod/job even though the first is still running. `DockerProvider` has the same bug in `create()` but `recover()` re-populates the maps before the first `create` call, masking it. K8s and Nomad have no equivalent bootstrap step. Per-codespace dedup breaks on restart.

Direction: fix as part of P1-03. The cluster listing in `recover()` must populate `codespaceToSandbox` before the service starts accepting `create()` calls, AND the guard should additionally probe the cluster on a cache miss (not only the in-memory map) so that two parallel replicas of the API server don't both create a sandbox for the same codespace. The DB `sandboxInstances` table is also authoritative — add a unique index on `(codespaceId, status='running')` to push dedup down to the DB as a last-resort guard.

### P1-05 Credentials injection writes the OAuth token via a shell exec that embeds it in the command string — base64 helps, but a compromised/hostile image can still capture it from argv

`credentials-injector.ts:71-87` injects OAuth credentials by base64-encoding the JSON and running `sh -c 'echo "<b64>" | base64 -d > /home/node/.claude/.credentials.json'` inside the sandbox. The base64 step removes shell-injection risk from the *credential contents*, but the full command (including the base64 blob) appears in the container's process table and audit logs. An adversary with a foothold in the sandbox (or a malicious base image — see P0-01) can `ps -ef` / `cat /proc/*/cmdline` on the injector exec and recover the token. The injector also runs BEFORE the agent-runner starts, so even a transient shell hijack inside the container gets a window to exfiltrate. Additionally `CLAUDE_OAUTH_TOKEN` is passed as a container env var in `container-exec.service.ts:767` — readable by every process in the sandbox via `/proc/1/environ`.

Direction: stream the token via stdin rather than argv (`sh -c 'cat > /path' <<<"$encoded"` via exec stdin, which is not visible in `/proc`). Better: use `docker cp` / K8s `cp` / Nomad file template equivalent to place the file without a shell. Drop `CLAUDE_OAUTH_TOKEN` from the env-var path once the credentials file is the SDK's primary source (CLAUDE.md already says the API blocks env-var OAuth). Cross-link to `01-security-and-auth.md` and `specs/sandbox/security/environment-variables.md`.

### P1-06 No network policy, egress filtering, or east-west isolation on any provider

`DockerProvider` uses `NetworkMode: 'bridge'` by default (`docker-provider.ts:568`) — every sandbox can reach every other sandbox on the host bridge and can egress to any internet endpoint. `AgentSandboxProvider` builds a CRD via `SandboxBuilder` with no `NetworkPolicy` (grep for `NetworkPolicy|egress` returns zero matches in `src/lib/sandbox`). `NomadSandboxProvider` sets no network stanza at all. A prompt-injection attack that makes the planning agent emit a `curl` to `$INTERNAL_SERVICE` will succeed. Two tenants' sandboxes on the same host or cluster can reach each other's ports.

Direction: at minimum, default `networkMode: 'none'` for the `execute` phase of agent runs (the plan phase rarely needs network). For K8s: generate a default-deny `NetworkPolicy` alongside the `Sandbox` CRD, explicitly allowlisting Anthropic API, npm registry, and GitHub. For Nomad: use Consul Connect or a `network { mode = "none" }` block. Make network-egress an opt-in config per-codespace. Cross-link to `specs/sandbox/security/secure-fs.md` (which currently focuses on FS, not network) and consider expanding that spec to cover network.

### P1-07 Resource limits are not validated per-tenant — `sandboxConfigSchema` caps at 32 GB memory / 16 CPU cores globally but nothing enforces a per-tenant ceiling

`types.ts:104-115` caps `memoryMb ≤ 32768` and `cpuCores ≤ 16` in the Zod schema. These are per-sandbox maxima, not per-tenant or per-team totals. A codespace can set `memoryMb: 32768, cpuCores: 16` and — combined with no quota enforcement at the K8s namespace or Nomad namespace level in the provider code — a single tenant can consume the entire cluster. `CodespaceSandboxConfig` has no `maxMemoryMbPerTenant` field. There is also no disk-quota enforcement in any provider; `SandboxMetrics.diskUsageMb` returns 0 in all three implementations (`docker-provider.ts:249`, `nomad-sandbox-instance.ts:415`, `agent-sandbox-instance.ts:331`).

Direction: introduce a per-team/per-codespace resource ceiling in the admin settings, validated in `SandboxConfigService` before the provider call. For K8s: generate a `ResourceQuota` per-namespace and document the expected team-to-namespace mapping. For Nomad: use Nomad `Quota` specifications. For Docker: enforce at the service layer since Docker has no native quota system. Track disk usage at least for warning thresholds — the `diskUsageMb: 0` returns are silently misleading ops dashboards.

---

## P2 — Maintainability / consistency / type-safety

### P2-01 Three near-identical tmux implementations across `DockerSandbox`, `AgentSandboxInstance`, `NomadSandboxInstance`

`docker-provider.ts:120-217` has `createTmuxSession/listTmuxSessions/killTmuxSession/sendKeysToTmux/captureTmuxPane`. `agent-sandbox-instance.ts:210-313` has the same five methods, copy-pasted with different error types. `nomad-sandbox-instance.ts:268-397` has the same five methods again with extra `assertRunning()` guards. The code comment at `docker-provider.ts:117-119` (`SC-037`) already tracks this as known duplication. Any fix to tmux parsing (session names with `:`, idle detection, window counting) needs three edits and three sets of tests. `src/lib/sandbox/tmux-manager.ts` already exists at the service layer — promote it to wrap any `Sandbox`-shaped exec target so the three instance classes can share it.

Direction: extract a `TmuxHelper` mixin / free-function set that takes a `Sandbox` and implements the five methods via `sandbox.exec()`. Make `DockerSandbox`/`AgentSandboxInstance`/`NomadSandboxInstance` delegate. Use provider-specific error codes by passing an error factory in. Retire `SC-037`.

### P2-02 `shellEscape` is implemented three times with subtle differences and `execStream` env-injection logic differs between Nomad (`lastIndexOf('exec ')`) and K8s (`indexOf('exec ')`)

`docker-provider.ts:267-270`, `agent-sandbox-instance.ts:100-102`, `nomad-sandbox-instance.ts:137-139` each define `shellEscape`. Identical implementation in all three — dead-obvious candidate for a shared util. More subtle: `agent-sandbox-instance.ts:154` uses `indexOf('exec ')` to locate the injection point for env vars while `nomad-sandbox-instance.ts:182` uses `lastIndexOf('exec ')` with a code comment saying "avoid matching 'exec' in path names". The K8s version is wrong for any path that contains `exec` (e.g. `/opt/foo-exec-bar/tool`). This is a latent bug waiting for a customer with a weird path.

Direction: move `shellEscape` and `buildExecShellCommand(cmd, args, cwd, env)` into `src/lib/sandbox/utils/shell.ts`. Have both Nomad and K8s call it. Write a test with `cwd: '/opt/foo-exec-bar'` to lock in the `lastIndexOf` behaviour.

### P2-03 `SandboxProviderEvent` is defined but `DockerProvider` emits more event types than the type allows, and the K8s/Nomad providers never emit `sandbox:idle` or `sandbox:stopping`

`sandbox-provider.ts:172-180` defines eight event variants. `DockerProvider.emit` calls only `sandbox:creating`, `sandbox:created`, `sandbox:started`, `sandbox:error` (`docker-provider.ts:541-610`). `AgentSandboxProvider` and `NomadSandboxProvider` emit the same four subset. Nothing emits `sandbox:idle`, `sandbox:stopping`, `sandbox:stopped` — those are published via the durable stream in `sandbox.service.ts:269` / `sandbox.service.ts:300`, not via the provider event bus. Listeners subscribing to the provider `on()` channel for idle signals will silently miss every event. The type claims support; the runtime doesn't deliver.

Direction: either narrow the `SandboxProviderEvent` union to the four events that are actually emitted, or make every provider also emit the lifecycle events when `stop()`/idle detection runs. Recommendation: route all provider lifecycle events through the bus (single source of truth), and have `sandbox.service.ts` subscribe to it for durable-stream republish, rather than publishing twice.

### P2-04 `sandboxId` slicing in CRD/job name construction truncates to 8 chars, creating collision risk across a large tenant set

`agent-sandbox-provider.ts:141` and `nomad-sandbox-provider.ts:146` both build the resource name as `agentpane-${codespaceId.slice(0,20)}-${sandboxId.slice(0,8)}`. cuid2 IDs have ~36 alphabet size; 8 chars = `36^8 ≈ 2.8e12` combinations — adequate for a single tenant but per-codespace the effective space is much smaller because only sandboxes for the same 20-char-prefix codespace collide. Two sandboxes created back-to-back for the same codespace (which shouldn't happen due to the mutex, but can happen if the mutex is bypassed — see P1-04) have a non-trivial collision chance. Docker doesn't slice (`docker-provider.ts:559` also uses 8 chars — same risk).

Direction: use 12+ chars of the sandbox ID suffix, or use the full ID and rely on DNS-1123's 63-char limit being handled by hashing the codespace prefix instead. Add a uniqueness check on the generated name before `createSandbox`/`registerJob` — if it exists, regenerate.

### P2-05 `validateContainers`/`validateSandboxes` silently remove entries — no event, no DB reconciliation

All three providers evict sandboxes from the in-memory cache when their refresh/inspect call returns 404 or errors (`docker-provider.ts:680-686`, `agent-sandbox-provider.ts:240-248`, `nomad-sandbox-provider.ts:274-283`). None of them update `sandboxInstances` in the DB or emit an event. Downstream the DB still says `status: 'running'`, the API returns stale data, and the UI shows a sandbox that doesn't exist. The idle-checker in `sandbox.service.ts:455-484` is separately reading from the DB and will try to `stop()` a sandbox that the provider has already evicted, triggering `CONTAINER_NOT_FOUND`.

Direction: whenever a provider evicts from the in-memory cache, it must (a) emit a `sandbox:stopped`/`sandbox:error` provider event and (b) have the service layer update the DB row to match. Add a test that creates a sandbox, deletes the underlying container out-of-band, calls `list()`, and asserts DB row status transitioned.

### P2-06 `SandboxStateManager` coexists with per-provider in-memory maps — three sources of truth for "is this sandbox running"

`SandboxStateManager` (`src/services/container-agent/sandbox-state.ts`) tracks `runningAgents` by `taskId`. Each provider tracks `sandboxes` and `codespaceToSandbox` internally. The DB `sandboxInstances` table tracks sandbox lifecycle. These three can — and do — disagree (see P2-05, P1-04). The service layer mostly uses the state manager for the task-level view and the provider map for the sandbox-level view, but `container-exec.service.ts:216` reads from both paths.

Direction: make `SandboxStateManager` the single source of truth for in-memory sandbox→codespace mapping; remove `codespaceToSandbox` from each provider; make providers stateless dispatchers that consult the state manager on `get()`. Or commit to provider-owned state and have `SandboxStateManager` only track agent execution (its original responsibility). Pick one; document the pick in `specs/sandbox/architecture/overview.md`.

### P2-07 Health checks don't probe sandbox liveness, only provider connectivity

`DockerProvider.healthCheck()` pings the Docker daemon. `AgentSandboxProvider.healthCheck()` calls `client.healthCheck()` (cluster + CRD registered). `NomadSandboxProvider.healthCheck()` checks cluster leader. None of them run a readiness probe on the sandbox pods/containers themselves. If a sandbox is stuck (OOMKilled and restarting, stuck in `CrashLoopBackoff`, tmux server dead, Claude CLI missing) no health endpoint surfaces it. The CRD K8s path relies on the controller's `Ready` condition, which is closer to right — but `mapConditionsToStatus` (`agent-sandbox-provider.ts:557-572`) maps transient `PodNotReady` back to `creating`, hiding a stuck pod from the UI.

Direction: add a per-sandbox liveness probe: `sandbox.exec('true')` (or an HTTP probe against the agent-runner if it exposes one) invoked on a timer and exposed through `sandbox.service.ts.getMetrics()`. Track consecutive failures and transition to `error` after N. For K8s: distinguish `creating` (first 30s since creation timestamp) from `stuck` (`PodNotReady` for > 60s).

### P2-08 `pullImage` / `isImageAvailable` are no-ops on K8s and Nomad (they trust the runtime) — means a bad image reference in config fails late, during pod schedule, with poor UX

`agent-sandbox-provider.ts:362-373`: `pullImage` and `isImageAvailable` just verify the string is non-empty. `nomad-sandbox-provider.ts:431-442`: same. If a tenant configures `image: 'nonexistent/typo:tag'`, the failure arrives via `waitForReady` timeout 120s later as `POD_CREATION_FAILED` with no indication that the root cause is a missing image. The user gets "sandbox creation failed" with no actionable signal.

Direction: make `isImageAvailable` actually check the image is pullable on K8s (e.g. create a short-lived `ImagePullJob` Pod with `imagePullPolicy: Always`, or query a registry catalog API). For Nomad: hit the Docker registry HEAD endpoint using the configured registry credentials. At minimum, detect `ImagePullBackOff` / `ErrImagePull` events from the pod and surface them through the provider error instead of a generic timeout.

---

## P3 — Polish / docs

### P3-01 `sandboxConfigSchema` allows `networkMode: 'bridge' | 'none'` but the K8s and Nomad providers ignore the field entirely

The Zod schema (`types.ts:114`) accepts `networkMode`. Only `DockerProvider.create()` (line 568) reads it. K8s and Nomad silently ignore it. Tenants who set `networkMode: 'none'` expecting isolation get it on Docker and don't get it on K8s/Nomad. Either drop the field from the non-Docker code paths explicitly, or implement equivalents (NetworkPolicy for K8s — see P1-06).

### P3-02 `specs/sandbox/README.md` claims "18 files" but only three subdirectories exist (`architecture/`, `security/`, plus `container/`, `sdk-integration/`, `terminal/`, `worktree/`). Each subdirectory has 2-3 markdown files. The CLAUDE.md line "Deep sandbox spec: `specs/sandbox/` (18 files)" is approximately correct but the spec does not cover the Nomad provider at all. `specs/sandbox/architecture/overview.md` and `isolation-layers.md` predate the Nomad provider landing. Add a `specs/sandbox/providers/` directory with one page per provider (docker, k8s, nomad) and a parity matrix.

### P3-03 `runtimeClassName: 'gvisor' | 'kata' | 'none'` is exposed in K8s provider options but no spec or docs discuss when to use which, what the trade-offs are, or whether gVisor is tested. Add a note in `specs/sandbox/architecture/isolation-layers.md` covering the runtime-class decision matrix.

### P3-04 `agent-sandbox-sdk` and `nomad-sandbox-sdk` under `packages/` are versioned independently but not published — the import is via workspace reference. Document the versioning/release story: do they pin 1:1 with the app, or do they target external K8s/Nomad cluster versions? Add to `packages/*/README.md` (if absent). This matters for the `@kubernetes/client-node 1.4.0` / K8s API version compatibility window.

### P3-05 The `SandboxMetrics` interface (`types.ts:39-47`) promises CPU %, memory MB, disk MB, network bytes, uptime. K8s and Nomad return zero for everything except `uptime` (`agent-sandbox-instance.ts:327-335`, `nomad-sandbox-instance.ts:411-419`). The UI's sandbox-indicator panel renders these zeros as "0 MB used" which is materially misleading. Either wire them up via `metrics-server` (K8s) / `nomad alloc status -stats` (Nomad), or mark them `| null` in the type and render "unavailable" in the UI.

---

## Summary

- **Findings**: 21 total
- **P0**: 1 (container image supply chain)
- **P1**: 7 (provider-parity drift, AgentCore zombie, missing cleanup for K8s/Nomad, restart-dup bug, credential-in-argv, no network policy, no resource quotas)
- **P2**: 8 (tmux duplication, shellEscape triplication, unused event types, short sandbox-ID slicing, silent cache eviction, three-way state duplication, shallow health checks, no-op `isImageAvailable` on K8s/Nomad)
- **P3**: 5 (docs + ignored `networkMode` field on non-Docker providers)

Roadmap context: `specs/roadmap/phase2-sandbox-plugins.md` anticipates additional providers. Any plugin work should first stabilise the `SandboxProvider` contract surfaced in P1-01 — adding a fifth provider on top of today's three-plus-one divergence would compound the maintenance cost.

---

## Resolution (April 2026 — theme-04 PR)

Landed in `theme-04-sandbox` (branch `p0-p1-april`):

| ID | Status | What changed |
|----|--------|--------------|
| P0-01 | Resolved | `SANDBOX_DEFAULTS.image` swapped to placeholder `ghcr.io/agentdevsl/agent-sandbox@sha256:0…0`. `SandboxConfigService.validateImage()` rejects tag-only refs. `projectSandboxConfigSchema.image` Zod-refined on the same regex. Dockerfile comment documents the publish-workflow follow-up (theme 11). |
| P1-01 | Resolved | `SandboxProvider.recover()` promoted to a required member; `RecoverResult` exported. Conformance test in `tests/lib/sandbox/sandbox-theme-04.test.ts` pokes every interface member on each provider. AgentCore is explicitly out of scope for this interface (see P1-02). |
| P1-02 | Resolved | AgentCore imports gated behind `AGENTCORE_ENABLED=true`. `ContainerAgentService.setAgentCoreProvider` now dynamically imports the provider; with the flag unset, the AWS-SDK-pulling module never enters the module graph. |
| P1-03 | Resolved | `AgentSandboxProvider.recover()` and `NomadSandboxProvider.recover()` added and wired into `k8s-init.ts` / `nomad-init.ts`. K8s lists Sandbox CRDs by label selector, re-registers running ones, deletes terminal ones. Nomad lists jobs by prefix, re-registers `running`, purges `dead`. |
| P1-04 | Partial — pre-existing | The DB schema already enforces `sandbox_instances.codespace_id` UNIQUE, which is stricter than the asked-for partial-unique. The in-memory `codespaceToSandbox` gap is now closed by the new K8s/Nomad `recover()` running on bootstrap before any create is accepted. A further refinement (partial unique on `status IN ('creating','running')` to allow history rows) is tracked as follow-up. |
| P1-05 | Partial (Docker) | `Sandbox.writeFile()` optional method added; `DockerSandbox.writeFile()` implemented via `putArchive` + hand-built USTAR tarball (zero new deps) so credentials never appear in argv. `CredentialsInjector` prefers `writeFile` when present, falls back to the legacy `sh -c` path for providers that haven't implemented it yet. K8s/Nomad implementations are tracked as follow-up. `CLAUDE_OAUTH_TOKEN` env-var removal is also follow-up. |
| P1-06 | Partial | `getDefaultSandboxNetworkMode()` reads `SANDBOX_DEFAULT_NETWORK_MODE` env; Docker provider honours the default; K8s/Nomad providers emit a warning at construction if operators have opted into `none`, because NetworkPolicy / network stanza generation is not yet implemented. Docker shipped; K8s/Nomad tracked. |
| P1-07 | Resolved (infrastructure) | `SandboxConfigService.assertQuota()` and the `SandboxQuota` / `QuotaCheckArgs` types exposed. Error code `SANDBOX_QUOTA_EXCEEDED` added. Plumbing from `sandbox.service.create()` to load tenant quota is the UX follow-up. |

**Tests added**: `tests/lib/sandbox/sandbox-theme-04.test.ts` — 20+ tests covering all of the above. `tests/lib/sandbox/sandbox-controller.test.ts` updated to match the digest-pinned default image.

**Follow-up tracked** (kept out of this PR to limit blast radius):

1. Theme 11: publish the real GHCR image and replace the placeholder digest in `SANDBOX_DEFAULTS.image`.
2. K8s `NetworkPolicy` emission + Nomad Consul Connect stanza.
3. K8s / Nomad `writeFile` implementation (`kubectl cp` equivalent / Nomad file template) and removal of the `sh -c` fallback in `CredentialsInjector`.
4. Drop `CLAUDE_OAUTH_TOKEN` from the container env-var path once the credentials file is the only source.
5. Per-tenant quota enforcement wired into `sandbox.service.create()` once tenant identity is plumbed through.
