# Sandbox Platforms, Overlay Approaches & Spin-up Techniques

## Filesystem Overlay and Sharing Approaches

### OverlayFS (Docker Native)

The foundational technology behind Docker's storage driver. Stacks read-only layers beneath a writable layer per container.

**Three-layer design (Blaxel production pattern):**
1. **Read-only base layer** — Frozen, compressed OS snapshot in EROFS format
2. **Memory-mapped kernel layer** — Kernel maps EROFS image directly from disk, loading pages on demand
3. **Writable overlay layer** — tmpfs-based in-memory layer for per-agent runtime modifications

**Performance:** 75% memory reduction (4GB Next.js image → ~1GB actual usage). Boot times decoupled from image size.

**AgentPane application:** Build a single base image with all shared skills/tools. Docker automatically shares read-only layers. Each agent gets a thin writable layer. Mount additional skills via `-v /host/skills:/skills:ro`.

### Lazy-Loading Image Formats

> "Pulling packages accounts for 76% of container start time, but only 6.4% of that data is read."

**eStargz (Enhanced Stargz):**
- Modified tar.gz supporting HTTP Range Requests for selective extraction
- Workload-aware prefetching: profiles access patterns, reorders entries
- Landmark file enables single HTTP Range Request to prefetch likely content
- containerd remote snapshotter plugin

**Nydus (RAFS):**
- Chunk-based content-addressable filesystem
- Backends: FUSE, virtiofs, in-kernel EROFS
- Can lazy-pull eStargz and OCI images without conversion
- Data deduplication and P2P distribution

### virtiofs (MicroVM Sharing)

Designed for sharing filesystems between host and guest VMs using shared memory.

| Benchmark | virtiofs (cache=always+dax) | virtio-9p | NFS |
|-----------|---------------------------|-----------|-----|
| Single file | 235 MB/s | 28 MB/s | — |
| 4-file mmap | 858 MB/s | 140 MB/s | — |

~8x faster than 9p. Full POSIX semantics. Requires hypervisor support.

### FUSE-Based Virtual Filesystems

**AgentFS (Turso):** SQLite-backed agent filesystem mounted as POSIX filesystem. Full POSIX semantics, Git integration, kernel writeback caching for near-native performance.

**FUSE for Agent Tool Exposure:** Domain data as filesystem operations. On-demand loading. Agents use `ls`, `grep`, `find` natively.

### Mount Type Performance

| Mount Type | Performance | Use Case |
|------------|------------|----------|
| Docker Volume | Fast (native driver) | Dependencies, node_modules |
| Bind Mount | **3.5x slower on Mac** (VM boundary) | Source code with hot reload |
| tmpfs | **Fastest** (pure RAM) | Caches, ephemeral work dirs, secrets |

---

## Sandbox Platforms

### Daytona — Fastest Container Starts

- **Technology:** Docker containers (Kata optional)
- **Cold start:** 27-90ms
- **Features:** Stateful snapshots, LSP support, Git built-in, LangChain integration, MCP server support
- **Pricing:** $200 free credits; startup program up to $50,000
- **Website:** https://www.daytona.io/

### E2B — Production-Proven Firecracker

- **Technology:** Firecracker microVMs
- **Cold start:** ~150ms (some configs 80ms)
- **Scale:** ~15M sandbox sessions/month, ~50% Fortune 500
- **Filesystem:** Custom templates from Dockerfiles; Build System 2.0 with 14x faster cached builds
- **Limitations:** No BYOC in production, 24h session ceiling, $0.05/hr per vCPU
- **Website:** https://e2b.dev

### Modal — Serverless Containers

- **Technology:** gVisor containers
- **Cold start:** Sub-1s (2-5s+ due to aggressive recycling)
- **Scale:** Zero to 20,000+ concurrent containers
- **Strengths:** GPU access, Python-native SDK, granular egress
- **Limitations:** Python-centric, no BYOC, SDK-defined images only
- **Website:** https://modal.com

### Fly.io Machines / Sprites

- **Technology:** Firecracker microVMs
- **Cold start:** Machines ~300ms; Sprites 1-12s
- **Sprites:** AI agent-optimised VMs with persistent storage, checkpoint/restore, rollback
- **Website:** https://fly.io

### Cloudflare Dynamic Workers

- **Technology:** V8 isolates + Linux namespace + seccomp
- **Cold start:** Milliseconds
- **Scale:** 1M concurrent workers demonstrated
- **Memory:** Megabytes per isolate (~100x more efficient than containers)
- **Limitations:** No filesystem, JavaScript-focused, edge-only
- **Website:** https://developers.cloudflare.com/workers/

### Docker Sandboxes (Experimental)

- **Technology:** MicroVM isolation inside Docker Desktop's VM
- **Filesystem:** Git worktree-based branch mode (`.sbx/` directories)
- **Security:** Credential proxy injection, three-tier network policies
- **Agents:** Claude Code, Gemini CLI
- **Status:** Experimental (Docker Desktop 4.50+)

### Kubernetes Agent Sandbox (kubernetes-sigs)

- **CRDs:** SandboxTemplate, SandboxWarmPool, SandboxClaim
- **Warm pool:** <100ms claim time
- **Isolation:** gVisor or Kata Containers per pod
- **Status:** Early (launched KubeCon November 2025)
- **GitHub:** https://github.com/kubernetes-sigs/agent-sandbox

### Alibaba OpenSandbox

- **Architecture:** Four-layer stack (SDKs → Specs → Runtime → Instances)
- **Backends:** Docker, Kubernetes, gVisor, Kata, Firecracker
- **Features:** Go-based execution daemon, Jupyter kernels, SSE streaming
- **GitHub:** https://github.com/alibaba/OpenSandbox

### Coder Prebuilds

- **Technology:** Terraform-based workspace provisioning
- **Warm pool:** `coder_workspace_preset` with `prebuilds { instances = N }`
- **Features:** Automatic reconciliation, TTL expiration, cron scaling
- **Website:** https://coder.com

---

## Spin-up Time Reduction Techniques

### Firecracker Snapshot/Restore (28ms)

| Operation | Duration |
|-----------|----------|
| Snapshot restore | **~28ms** |
| Cold boot | ~1.1s |
| Docker alpine start | ~180ms |
| Python exec in Firecracker | ~45ms |
| Sandbox destruction | ~15ms |

**How it works:** Memory-mapped snapshot files with CoW overlays per VM. Base snapshot stays read-only. 50 concurrent VMs from single snapshot sharing memory pages.

### CRIU Checkpoint/Restore

Container checkpointing beta in Kubernetes v1.30. Freezes running container, saves complete state to disk, restores exactly where it left off.

- Docker: `docker checkpoint create` / `docker start --checkpoint` (experimental)
- Kubernetes: Checkpoint/Restore Working Group (January 2026)
- Not all applications checkpoint cleanly

### Pre-Warmed Container Pools

**Kubernetes Agent Sandbox:**
- SandboxWarmPool maintains N pre-warmed pods
- SandboxClaim for instant provisioning (<100ms)
- Automatic reconciliation

**Coder:** Terraform-based warm pools with TTL and cron scaling.

**Fission:** Maintains pools of pre-warmed containers; function specialisation in milliseconds.

### Container Image Pre-Pulling

**Impact:** 1GB image: 60s without cache → 1s with cache.

**Methods:**
- DaemonSet running `sleep 720h` containers with desired images
- Kubernetes Image Puller DaemonSet
- GKE secondary boot disks

### Copy-on-Write Filesystems (ZFS/Btrfs)

- **ZFS:** Instant snapshots and clones. Block Reference Table for efficient cloning. VM provisioning from 20min to <2min.
- **Btrfs:** Writable snapshots, instant cloning via CoW.

### WebAssembly Sandboxes

| Platform | Cold Start | Memory |
|----------|-----------|--------|
| Spin (Fermyon) | Sub-millisecond (~0.5ms) | Minimal |
| WasmEdge | Milliseconds | ~2MB |

**Limitations:** Not a full Linux environment. Limited language support. No Docker/system tools.

---

## Sources

- [OverlayFS Memory Reduction (Blaxel)](https://blaxel.ai/blog/how-to-slash-sandbox-memory-usage-by-75-using-overlayfs)
- [Firecracker 28ms Sandboxes](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k)
- [AI Sandbox Comparison 2026](https://lifo.sh/blog/ai-sandbox-comparison-2026)
- [Best Sandbox Runners 2026 (Better Stack)](https://betterstack.com/community/comparisons/best-sandbox-runners/)
- [Northflank: How to Sandbox AI Agents](https://northflank.com/blog/how-to-sandbox-ai-agents)
- [Kubernetes Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [eStargz Lazy Loading](https://medium.com/nttlabs/startup-containers-in-lightning-speed-with-lazy-image-distribution-on-containerd-243d94522361)
- [Nydus Snapshotter](https://github.com/containerd/nydus-snapshotter)
- [CRIU Checkpoint/Restore](https://criu.org/Main_Page)
- [Docker Mount Comparison](https://eastondev.com/blog/en/posts/dev/20251217-docker-mount-comparison/)
- [FUSE Is All You Need](https://jakobemmerling.de/posts/fuse-is-all-you-need/)
- [AgentFS FUSE (Turso)](https://turso.tech/blog/agentfs-fuse)
- [virtiofs Performance](https://virtio-fs.gitlab.io/)
- [Alibaba OpenSandbox](https://github.com/alibaba/OpenSandbox)
- [Cloudflare Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/)
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)
