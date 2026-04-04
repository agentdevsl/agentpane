# Agent Filesystem Solutions — Ranked for AgentPane

## AgentPane Execution Backends

AgentPane has three sandbox providers. Solutions must be compatible with one or more of these:

| Provider | Path | Interface | Notes |
|----------|------|-----------|-------|
| **Docker** (endpoint) | Container exec | `SandboxProvider` | bind mounts, exec, tmux |
| **K8s Agent Sandbox** | `@agentpane/agent-sandbox-sdk` | `EventEmittingSandboxProvider` | Already uses Agent Sandbox CRD (`SandboxBuilder`, `SandboxWarmPool`, `AgentSandboxClient`), gVisor/Kata runtime classes, warm pool with `initWarmPool()` |
| **AgentCore** | AWS Bedrock invoke+SSE | `AgentCoreSandboxProvider` | microVM on-demand by AWS, no exec/shell |

### Agent Execution Model

The `agent-runner` creates a Claude Agent SDK session (`unstable_v2_createSession()`) which spawns the **Claude Code CLI as a child process**. The CLI provides all tooling (Read, Write, Bash, Edit, Glob, Grep) — these execute as real OS operations inside the host environment. The `Bash` tool runs actual shell commands (`git`, `npm`, etc.).

This means any runtime that can host the Claude Agent SDK + Claude Code CLI is a viable execution environment. The SDK manages tool execution — the sandbox only needs to provide:
- **Node.js 22+** runtime (for the agent-runner)
- **Claude Code CLI** binary
- **`child_process` spawn capability** (SDK spawns CLI as subprocess)
- **Filesystem access** (CLI tools Read/Write/Edit/Glob operate on the local filesystem)
- **Shell execution** (Bash tool runs commands via the host shell)

### Constraints

- Solutions must integrate with at least one existing provider without replacing the provider interface
- AgentCore is AWS-managed — we cannot control its filesystem or spin-up; improvements must target Docker and K8s
- K8s provider already has warm pool support (`enableWarmPool`, `warmPoolSize`) — enhancements build on this
- Skills are currently file-based (Agent Skills format) and need to be mountable into both Docker containers and K8s pods
- The SDK spawns Claude Code CLI as a child process — environments must support `child_process.spawn()`

---

## Ranking Criteria

| Dimension | What it measures |
|-----------|-----------------|
| **Skill Mounting** | Centralised, shared, read-only skill distribution into Docker containers and K8s pods |
| **Spin-up Speed** | Cold-start reduction for Docker `create` and K8s pod scheduling |
| **Compatibility** | Works with existing `SandboxProvider`/`AgentSandboxProvider` interfaces and `SandboxConfig` |
| **Operational Cost** | Infrastructure complexity, maintenance burden, new dependencies |

Scores: 1 = Poor, 2 = Below Average, 3 = Adequate, 4 = Good, 5 = Excellent

---

## Tier 1: Direct Improvements to Existing Providers

### 1. Docker OverlayFS Shared Base + Read-Only Skill Mounts

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | **5** | `-v /host/skills:/skills:ro` in Docker; ConfigMap/PV in K8s |
| Spin-up Speed | 4 | Shared layers avoid re-pulling; warm pool for instant claim |
| Compatibility | **5** | Already how Docker works; just needs `SandboxConfig` bind mount additions |
| Operational Cost | **5** | Zero new infrastructure |
| **Overall** | **4.8** | |

**What it is:** Build one base image with all shared CLIs and tools pre-installed. Mount skill directories as read-only bind mounts into each container. Docker's OverlayFS automatically deduplicates shared image layers.

**How it fits AgentPane:**
- Docker provider (`docker-provider.ts`): Add read-only bind mounts to `SandboxConfig` for `/skills` directory
- K8s provider (`agent-sandbox-provider.ts`): Add PersistentVolume or ConfigMap mounts via `SandboxBuilder`
- Skills directory on host updated independently of image rebuilds
- Zero changes to `SandboxProvider` interface — just config additions

**Implementation:**
```typescript
// SandboxConfig addition
interface SandboxConfig {
  // ... existing fields
  skillMounts?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
}
```

**Benefits:** No new tech. Skills update without image rebuild. Works today for both Docker and K8s.
**Issues:** Skills must be present on every Docker host / K8s node. No content-addressable deduplication.

---

### 2. K8s Warm Pool Tuning + Docker Container Pre-Creation

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 3 | Warm containers already have skills mounted |
| Spin-up Speed | **5** | <100ms claim from warm pool; Docker pre-created containers ~200ms |
| Compatibility | **5** | K8s provider already has `enableWarmPool`/`warmPoolSize`; Docker needs pool logic |
| Operational Cost | 4 | Consumes resources for idle containers; needs replenishment logic |
| **Overall** | **4.3** | |

**What it is:** K8s already supports warm pools via `AgentSandboxProviderOptions.enableWarmPool`. For Docker, implement an equivalent: pre-create N containers with skills mounted, claim on demand.

**How it fits AgentPane:**
- K8s: Already implemented in `agent-sandbox-provider.ts` with `SandboxWarmPool` from SDK. Tune `warmPoolSize` based on load.
- Docker: Add `WarmPoolManager` that maintains N idle containers via `docker-provider.ts`. On `create()`, check pool first.

**Benefits:** Eliminates cold-start for both providers. Skills pre-loaded in warm containers.
**Issues:** Idle resource cost. Pool exhaustion under burst load. Docker pool requires new management logic.

---

### 3. Nydus / eStargz Lazy-Loading Images

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 4 | Only pull skill/tool files actually accessed by agents |
| Spin-up Speed | 4 | Eliminates 76% of image pull time |
| Compatibility | 4 | K8s containerd snapshotter plugin; Docker requires buildkit config |
| Operational Cost | 3 | Requires snapshotter setup and image optimisation step |
| **Overall** | **3.8** | |

**What it is:** Container image formats that support lazy-loading — only fetch files from the registry as they are accessed. 76% of container image data is never read.

**How it fits AgentPane:**
- K8s: Install Nydus snapshotter as containerd plugin. Agent sandbox images converted to Nydus format.
- Docker: eStargz support via BuildKit. Rebuild agent base image with eStargz optimisation.
- No changes to `SandboxProvider` interface — this is infrastructure-level.

**Benefits:** Dramatically faster first-time image pull. Only tools actually used by agents get fetched.
**Issues:** First access to uncached files adds latency. Requires snapshotter plugin. Only valuable if base images are large (>2GB).

---

### 4. OCI Artifact Registry for Skill Packages

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | **5** | Content-addressable, versioned, immutable skill distribution |
| Spin-up Speed | 3 | Registry pull adds latency; mitigated by node-level caching |
| Compatibility | 4 | Pull skills with ORAS, mount into containers via init container or volume |
| Operational Cost | 3 | New registry workflow; init container adds startup time |
| **Overall** | **3.8** | |

**What it is:** Package Agent Skills as OCI artifacts (using ORAS). Push to existing registry (Docker Hub, ECR, ACR). Pull and mount into sandboxes.

**How it fits AgentPane:**
- K8s: Init container that pulls skill artifacts from registry before agent starts. Or DaemonSet that maintains local skill cache on each node.
- Docker: Pull skills to host-level cache directory, bind-mount into containers.
- Skill versions pinned by digest — immutable, reproducible.

**Benefits:** Versioned skills. Content-addressable dedup. Uses existing registry infra.
**Issues:** New packaging/publishing workflow. Init container adds startup time. Overkill for small skill sets.

---

## Tier 2: Future Enhancements

### 5. Firecracker Snapshot/Restore (New Provider)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 4 | Snapshot includes skills; virtiofs for host dir sharing |
| Spin-up Speed | **5** | 28ms restore from snapshot |
| Compatibility | 2 | Requires new `FirecrackerSandboxProvider` — different from Docker/K8s |
| Operational Cost | 2 | New infra (Firecracker daemon), Linux-only, no macOS dev |
| **Overall** | **3.3** | |

**What it is:** Boot a microVM once with all skills, snapshot at "ready" state. Restore in 28ms with CoW overlays for per-agent isolation.

**How it fits AgentPane:**
- New `FirecrackerSandboxProvider` implementing `SandboxProvider` interface
- `exec()` via vsock instead of Docker exec
- Snapshot management service for base image versioning
- Only viable for production Linux hosts (not dev)

**Benefits:** Best-in-class spin-up (28ms). Full OS isolation (<5MB per VM). 50+ concurrent VMs from single snapshot.
**Issues:** New provider implementation. Linux-only. No `docker exec` equivalent. Debugging harder. Significant new operational complexity.

**Recommendation:** Phase 3 enhancement. Evaluate after K8s warm pool is fully tuned and Docker pool is implemented.

---

### 6. Daytona as Sandbox Backend

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 3 | Docker-compatible; mount skills same as Docker provider |
| Spin-up Speed | **5** | 27-90ms cold starts |
| Compatibility | 3 | New provider wrapping Daytona SDK; same `SandboxProvider` interface |
| Operational Cost | 3 | External service dependency; vendor costs |
| **Overall** | **3.5** | |

**What it is:** Third-party sandbox platform with fastest production container cold starts (27-90ms). Docker-compatible, MCP server support.

**How it fits AgentPane:**
- New `DaytonaSandboxProvider` implementing `SandboxProvider`
- API-compatible with Docker workflow (OCI images, exec, etc.)
- Skills mounted same way as Docker (bind mounts / volumes)

**Benefits:** Sub-100ms without Firecracker complexity. LSP support. Git built-in.
**Issues:** External dependency. Vendor costs. Self-hosted maturity unclear. Another provider to maintain.

---

---

## Tier 3: Interesting but Not Primary Solutions

### 7. TigerFS (Multi-Agent Coordination)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 1 | Not designed for skill distribution |
| Spin-up Speed | 1 | Not a sandbox; doesn't affect spin-up |
| Compatibility | 2 | FUSE mount needs `SYS_ADMIN` in containers; won't work in AgentCore |
| Operational Cost | 2 | Requires PostgreSQL; FUSE complexity in containers |
| **Overall** | **1.5** | |

**What it is:** FUSE filesystem backed by PostgreSQL. ACID transactions via filesystem semantics. Multi-agent task coordination via `mv`.

**Relevance:** Solves a different problem (coordination, not sandbox/skills). AgentPane already has task services, session events, and durable streams for coordination. The ACID-task-claiming-via-filesystem pattern is interesting but redundant with existing architecture.

**Recommendation:** Not applicable to the two core problems. Revisit only if AgentPane moves to a filesystem-based coordination model.

---

### 8. Secure Exec (Rivet) — V8 Isolate

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 2 | Virtual in-memory filesystem; skills loaded into isolate at init |
| Spin-up Speed | **5** | 16ms cold start; 3.4MB per instance |
| Compatibility | 2 | Has Node.js `child_process` bridge but unclear if Claude CLI binary can run inside V8 isolate |
| Operational Cost | 4 | npm package; lightweight; no infra |
| **Overall** | **3.3** | |

**What it is:** V8 isolate-based code execution with Node.js compatibility bridges for `fs`, `child_process`, `http`, `net`. Deny-by-default permissions. 16ms cold starts.

**Key insight — SDK tooling vs OS:** The Claude Agent SDK provides all tooling (Read, Write, Bash, Edit, Glob, Grep) via the Claude Code CLI, which is spawned as a child process. Secure Exec bridges `child_process` — so in theory the SDK could spawn the CLI inside the isolate. However:

- The Claude Code CLI is a **native binary** (not pure JS) — V8 isolates can run JS, not native binaries
- `child_process.spawn()` in Secure Exec bridges to the host — this means the CLI would actually run on the host, defeating isolation
- The `Bash` tool executes shell commands — these would also bridge to the host shell
- The in-memory filesystem means file operations would need explicit syncing

**Verdict:** The `child_process` bridge makes it technically possible to run the SDK, but the CLI and Bash commands execute on the host — so isolation is illusory. The agent's file operations and shell commands would escape the V8 boundary.

**Recommendation:** Not suitable as primary sandbox. The isolation boundary doesn't contain the tools the SDK actually uses. Could work for lightweight non-CLI code execution tasks.

---

### 9. Rivet Agent OS — WASM + V8

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 3 | Virtual filesystem with WASM coreutils; skills loadable |
| Spin-up Speed | **5** | 4.8ms cold start; 22MB memory |
| Compatibility | 3 | Explicitly supports Claude Code; POSIX coreutils via WASM; virtual OS layer |
| Operational Cost | 3 | Early stage; new execution model |
| **Overall** | **3.5** | |

**What it is:** A "portable OS for agents" — JavaScript kernel managing virtual filesystem, process table, pipes, PTYs, network stack. POSIX coreutils compiled to WASM. Explicitly lists Claude Code as a supported agent.

**Key insight — SDK tooling compatibility:** Agent OS claims Claude Code support, which means the SDK's `child_process.spawn()` for the CLI and the CLI's tool execution (Bash, Read, Write, etc.) should work within the virtual OS:

- **Filesystem tools** (Read/Write/Edit/Glob/Grep): Operate on the virtual filesystem — contained
- **Bash tool**: Shell commands execute via WASM coreutils — `ls`, `grep`, `cat` work natively
- **Git operations**: This is the gap — `git` is a complex binary. WASM git (isomorphic-git) exists but has limitations
- **npm/bun**: Package managers are native binaries — unclear if they work in Agent OS

**Open questions:**
1. Does Agent OS actually run the Claude Code CLI binary, or does it run a JS-based reimplementation?
2. How are non-WASM binaries (git, npm, bun) handled? Host bridge? WASM compilation?
3. What is the filesystem persistence model across sessions?
4. Is the virtual filesystem fast enough for large repo operations?

**Recommendation:** Most promising lightweight alternative. Investigate Claude Code compatibility claims. If git and basic toolchain work inside Agent OS, this could replace Docker for simple agent tasks with 4.8ms cold starts. Needs proof-of-concept validation.

---

### 10. CRIU Checkpoint/Restore (Docker & K8s)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 2 | Checkpoint includes installed tools but not dynamic skills |
| Spin-up Speed | 4 | Near-instant restore from checkpoint |
| Compatibility | 3 | Docker experimental; K8s beta (v1.30) |
| Operational Cost | 3 | Beta status; not all apps checkpoint cleanly |
| **Overall** | **3.0** | |

**What it is:** Freeze a running Docker container, save state to disk, restore instantly. Kubernetes beta in v1.30.

**How it fits AgentPane:**
- Docker: `docker checkpoint create` / `docker start --checkpoint`
- K8s: Checkpoint/Restore Working Group, targeting GA

**Benefits:** Works with existing containers. No new runtime. Kubernetes-native path.
**Issues:** Experimental/beta. Not all processes checkpoint cleanly (especially long-lived connections). Storage driver compatibility.

**Recommendation:** Monitor. Adopt when K8s reaches GA and Docker support stabilises.

---

### 11. Cloudflare Dynamic Workers (N/A)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 1 | No filesystem; data via SQLite/R2 only |
| Spin-up Speed | **5** | Millisecond cold starts |
| Compatibility | 0 | Cannot implement `SandboxProvider`; no exec, no filesystem |
| Operational Cost | 4 | Managed service; minimal ops |
| **Overall** | **2.5** | |

**Relevance:** Cannot run agents. No filesystem, no shell, no git. Only relevant for edge API endpoints or MCP server hosting.

---

### 12. Modal

| Dimension | Score | Notes |
|-----------|-------|-------|
| Skill Mounting | 2 | SDK-defined environments only |
| Spin-up Speed | 3 | Sub-1s but unpredictable due to recycling |
| Compatibility | 1 | Python-centric; new provider; SDK-defined images only |
| Operational Cost | 3 | Vendor-hosted; Python SDK doesn't fit TypeScript stack |
| **Overall** | **2.3** | |

**Relevance:** Python-centric SDK. AgentPane is TypeScript/Bun. Not a natural fit.

---

## Comparison Matrix

| # | Solution | Skill | Speed | Compat | OpCost | **Overall** | Providers |
|---|----------|:-----:|:-----:|:------:|:------:|:-----------:|-----------|
| 1 | OverlayFS + Skill Mounts | **5** | 4 | **5** | **5** | **4.8** | Docker, K8s (existing) |
| 2 | Warm Pool Tuning | 3 | **5** | **5** | 4 | **4.3** | K8s (existing warm pool), Docker (new) |
| 3 | Nydus/eStargz | 4 | 4 | 4 | 3 | **3.8** | Docker, K8s (existing) |
| 4 | OCI Skill Registry | **5** | 3 | 4 | 3 | **3.8** | Docker, K8s (existing) |
| 5 | Rivet Agent OS | 3 | **5** | 3 | 3 | **3.5** | New provider (claims Claude Code support) |
| 6 | Daytona Backend | 3 | **5** | 3 | 3 | **3.5** | New provider |
| 7 | Secure Exec | 2 | **5** | 2 | 4 | **3.3** | Partial (CLI escapes isolate) |
| 8 | Firecracker Snapshots | 4 | **5** | 2 | 2 | **3.3** | New provider |
| 9 | CRIU | 2 | 4 | 3 | 3 | **3.0** | Docker, K8s (existing) |
| 10 | Cloudflare Workers | 1 | **5** | 0 | 4 | **2.5** | Incompatible |
| 11 | Modal | 2 | 3 | 1 | 3 | **2.3** | New provider |
| 12 | TigerFS | 1 | 1 | 2 | 2 | **1.5** | N/A |

> **Note:** K8s Agent Sandbox CRDs (`kubernetes-sigs/agent-sandbox`) are not listed separately — AgentPane already uses them via `@agentpane/agent-sandbox-sdk` with `SandboxBuilder`, `SandboxWarmPool`, and `AgentSandboxClient`. Improvements to the K8s provider are covered under items 1-4.

---

## Recommended Implementation Roadmap

### Phase 1: Immediate (no new infra, both providers)

| Action | Provider | Effort | Impact |
|--------|----------|--------|--------|
| Add `skillMounts` to `SandboxConfig` | Docker + K8s | Small | Centralised skills |
| Read-only bind mounts for skill dirs | Docker | Small | Shared skills across containers |
| PersistentVolume/ConfigMap skill mounts | K8s | Small | Shared skills across pods |
| Shared base image with pre-installed tools | Both | Medium | Faster pulls, less duplication |
| Tune `warmPoolSize` based on load metrics | K8s (already has `initWarmPool()`) | Small | Faster agent starts |
| Implement Docker warm container pool | Docker | Medium | Sub-500ms agent starts |
| Image pre-pulling on Docker hosts | Docker | Small | Eliminates first-pull latency |

**Expected result:** Centralised skills for both providers. K8s <100ms (warm pool). Docker <500ms (warm pool).

### Phase 2: Enhanced (3-6 months)

| Action | Provider | Effort | Impact |
|--------|----------|--------|--------|
| OCI artifact packaging for skills | Both | Medium | Versioned, immutable skill distribution |
| Nydus/eStargz if images grow large | K8s | Medium | Faster image pulls |
| Evaluate Rivet Agent OS for lightweight tasks | New | Medium | 4.8ms starts if Claude Code compatibility confirmed |

**Expected result:** Versioned skill packages. Sub-2s cold starts even without warm pool.

### Phase 3: Future (6-12 months, if needed)

| Action | Provider | Effort | Impact |
|--------|----------|--------|--------|
| Firecracker snapshot/restore provider | New | Large | 28ms agent starts |
| CRIU checkpoint/restore | Docker, K8s | Medium | Near-instant restore |
| Content-addressable skill store | Both | Large | Deduplication at scale |

**Expected result:** Sub-50ms agent starts. Hardware-level isolation. Deduplicated skill storage.
