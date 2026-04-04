# Agent Filesystem Research

Research into filesystem approaches for centralised skill mounting and reduced agent sandbox spin-up time.

## Documents

| Document | Description |
|----------|-------------|
| [rankings.md](rankings.md) | Ranked evaluation of all solutions for AgentPane |
| [tigerfs.md](tigerfs.md) | TigerFS — FUSE-based PostgreSQL filesystem for multi-agent coordination |
| [secure-exec.md](secure-exec.md) | Secure Exec & Rivet ecosystem — V8 isolate sandboxing |
| [sandbox-platforms.md](sandbox-platforms.md) | Sandbox platforms, overlay/sharing approaches, spin-up techniques |
| [skill-distribution.md](skill-distribution.md) | Skill packaging standards, MCP, CAS, and distribution ecosystems |

## Problem Statement

AgentPane needs to solve two related problems:

1. **Centralised skills and mounting for reuse** — Share common tools, skills, CLIs, and dependencies across multiple agent sandboxes without duplicating them in each container
2. **Reducing agent execution spin-up time** — Minimise cold-start latency when launching sandboxed agents (target: <2 seconds)

## AgentPane Execution Backends

Solutions are ranked against AgentPane's three existing sandbox providers:

| Provider | Path | Key constraint |
|----------|------|---------------|
| **Docker** (endpoint) | Container exec via `SandboxProvider` | Bind mounts, exec, tmux |
| **K8s Agent Sandbox** | `@agentpane/agent-sandbox-sdk` | Warm pool, gVisor/Kata, `SandboxBuilder` |
| **AgentCore** | AWS Bedrock invoke+SSE | AWS-managed; cannot control filesystem or spin-up |

## Key Findings Summary

- **#1: OverlayFS + read-only skill mounts** (score 4.8) — zero new infra, works for both Docker and K8s
- **#2: Warm pool tuning** (score 4.3) — K8s already has it; Docker needs pool implementation
- **#3-5: Nydus/eStargz, OCI skill registry, K8s CRDs** (score 3.8) — medium-term enhancements
- **Firecracker snapshot/restore** (28ms) — best spin-up but requires new provider, Phase 3
- **TigerFS** — coordination layer, not sandbox; redundant with existing task services
- **Secure Exec / Rivet** — V8 isolates incompatible with agent OS requirements
- **Agent Skills standard** — emerging skill format, 30+ tools, adopt for skill definitions
