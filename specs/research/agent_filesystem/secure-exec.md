# Secure Exec & Rivet Ecosystem

> V8 isolate-based secure code execution — no containers, no VMs

## Secure Exec

- **GitHub:** https://github.com/rivet-dev/secure-exec
- **Docs:** https://secureexec.dev/docs
- **License:** Apache-2.0
- **Version:** v0.2.1 (March 31, 2025) — pre-1.0
- **Built by:** Rivet (rivet.dev)

### Architecture

Three core layers:

1. **V8 Isolates** — Each execution runs in its own isolated V8 heap. JIT-compiled by TurboFan (same as production Node.js/Chrome)
2. **Virtual Kernel** — System bridge with granular permissions. Mounts runtimes (Node.js, WasmVM for shell commands)
3. **Permission Model** — Deny-by-default. Filesystem, networking, child processes, and env vars blocked until explicitly permitted

### API Surface

```javascript
import { createKernel, createInMemoryFileSystem, NodeRuntime } from 'secure-exec';

// Low-level
const kernel = createKernel();
const fs = createInMemoryFileSystem();

// High-level (agent-focused)
const runtime = new NodeRuntime(createNodeDriver());
await runtime.run(code, filepath);  // Execute with auto-exports
await runtime.exec(command);         // Process-style with stdout/stderr
```

### Performance

| Metric | Secure Exec | E2B (fastest sandbox) |
|--------|------------|----------------------|
| p50 cold start | **16.2ms** | 440ms |
| p95 cold start | **17.9ms** | 950ms |
| p99 cold start | **17.9ms** | 3,150ms |
| Memory per instance | **~3.4MB** | ~256MB |
| Concurrent on 1GB | ~210 | ~4 |
| Cost (AWS ARM) | $0.000011/s | $0.000625/s (56x more) |

### Security Model

- V8 heap isolation per execution (separate memory)
- Deny-by-default permission gates for all system resources
- Composable permissions (e.g., allow read-only fs, allow fetch but block spawn)
- CPU time budgets with deterministic exit code 124 on timeout
- Memory caps per isolate

### Node.js Compatibility

Bridges real host capabilities (not stubs) for: `fs`, `child_process`, `http`, `net`, `dns`, `process`, `os`. Frameworks like Express, Hono, and Next.js work out of the box.

### Limitations

- Code runs **within the host process** (V8 isolate, not OS-level isolation)
- **No persistent disk** across executions in default in-memory filesystem mode
- **Single-threaded V8** (no true parallelism)
- Cannot run system packages (no apt-get, etc.)
- Pre-1.0 with breaking API changes expected

---

## Rivet Agent OS

- **GitHub:** https://github.com/rivet-dev/agent-os
- **Product page:** https://rivet.dev/agent-os/

A full "portable OS for agents" combining WebAssembly (POSIX coreutils compiled to WASM) + V8 isolates + JavaScript kernel.

| Metric | Value |
|--------|-------|
| p50 cold start | **4.8ms** |
| Memory | ~22MB |
| Cost (AWS ARM) | ~$0.0000032/s |

### Components

- Virtual filesystem, process table, pipes, PTYs, network stack
- POSIX coreutils compiled to WASM (`ls`, `grep`, `cat`, etc.)
- Supports Claude Code, Codex, Amp, OpenCode as agent backends

---

## Rivet Sandbox Agent SDK

- **GitHub:** https://github.com/rivet-dev/sandbox-agent
- **Docs:** https://sandboxagent.dev/

A Rust binary providing a universal HTTP API to control coding agents inside sandboxes:
- One API, swap agents (Claude Code, Codex, OpenCode, Amp) with a config change
- Streams events in a universal schema for persistence and replay
- The "heavy workload" complement to Secure Exec

---

## Comparison of Rivet Products

| Solution | Cold Start | Memory | Isolation | Full OS | Use Case |
|----------|-----------|--------|-----------|---------|----------|
| Secure Exec | 16ms | 3.4MB | V8 isolate | No | Lightweight tool calls |
| Agent OS | 4.8ms | 22MB | WASM + V8 | Virtual | Medium-weight agents |
| Sandbox Agent | Varies | Varies | Container/VM | Yes | Full coding agents |

## AgentPane Relevance

**Secure Exec** is too lightweight for AgentPane's primary agent execution (agents need full OS — shell, git, npm, Claude Code CLI). However, it could be useful for:

- Running user-provided code snippets within the API server
- Executing validators or transformers without container overhead
- Lightweight MCP tool execution

**Agent OS** is more interesting but very early. If it matures and proves Claude Agent SDK compatibility, it could handle simple agent tasks that don't need full Docker.

**Sandbox Agent SDK** aligns most closely with AgentPane's needs but adds a Rust dependency and its own control plane — potential overlap with AgentPane's existing agent execution service.
