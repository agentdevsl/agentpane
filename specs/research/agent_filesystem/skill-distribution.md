# Skill Distribution, Packaging Standards & Content-Addressable Storage

## Agent Skills Open Standard

The single most significant development in agent skill distribution. Originally developed by Anthropic, released as open specification December 18, 2025. Adopted by 30+ AI agent tools.

- **Specification:** https://agentskills.io/specification
- **Overview:** https://agentskills.io/home

### Skill Directory Structure

```
skill-name/
  SKILL.md          # Required: YAML frontmatter + markdown instructions
  scripts/          # Optional: executable code
  references/       # Optional: documentation loaded on-demand
  assets/           # Optional: templates, schemas, resources
```

### SKILL.md Frontmatter

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | 1-64 chars, lowercase + hyphens, must match directory name |
| `description` | Yes | 1-1024 chars, describes what skill does and when to use |
| `license` | No | License name or reference |
| `compatibility` | No | Environment requirements |
| `metadata` | No | Arbitrary key-value pairs (author, version, etc.) |
| `allowed-tools` | No | Pre-approved tools (experimental) |

### Progressive Disclosure

The key design insight:
1. **Startup:** Load only `name` and `description` (~100 tokens per skill)
2. **Trigger:** Full SKILL.md body loads (<5000 tokens recommended)
3. **Execution:** Scripts and reference files load only when needed

Agents can access hundreds of skills without consuming context.

### Distribution Ecosystem

| Marketplace | Skills | Downloads | Notes |
|-------------|--------|-----------|-------|
| SkillsMP (skillsmp.com) | 351,000+ | — | Sourced from GitHub |
| Skills.sh (Vercel) | 83,627 | 8M+ | Supports 18 agents |
| ClawHub | ~3,200 | 1.5M+ | Curated |

### Versioning (Current State)

**No built-in versioning** in the spec. The `metadata` field supports optional `version` string (informational only).

Production workarounds:
- Directory-based: `.claude/skills/v1/`, `.claude/skills/v2/`
- Git-based: skills in repos, pinned to commits/tags
- CI/CD pipelines validating skill changes

---

## MCP (Model Context Protocol) as Tool Distribution

Complementary standard for dynamic tool exposure. Skills are static instruction bundles; MCP provides live tools-as-services.

### Architecture

- **Transport:** JSON-RPC 2.0 over Streamable HTTP (remote) or stdio (local)
- **Server features:** Resources (data/context), Prompts (templates), Tools (functions)
- **Client features:** Sampling (recursive LLM calls), Roots (filesystem boundaries), Elicitation (user input)

### MCP Registry

Official centralised catalog and API for MCP servers. API freeze (v0.1) October 2025.

Enterprise solutions:
- **Kong MCP Registry:** Governance, approval workflows, audit trails
- **MCP-Hive:** Billing layer for publishers/consumers
- **MCP Gateway Registry:** OAuth-secured enterprise gateway

### Scale

97M+ monthly SDK downloads, 10,000+ indexed servers. Backed by Anthropic, OpenAI, Google, Microsoft. Governance transferred to Agentic AI Foundation (AAIF) under Linux Foundation December 2025.

### 2026 Roadmap

- Agent-to-agent communication (MCP servers as autonomous participants)
- Server discovery (standard mechanisms for registries/crawlers)
- Horizontal scaling (addressing stateful session challenges)

---

## Framework-Specific Approaches

### LangChain/LangGraph — Semantic Tool Retrieval

**LangGraph-BigTool** enables access to hundreds/thousands of tools via semantic retrieval:
1. Tools registered with unique IDs in dictionary-based registry
2. Metadata indexed using semantic embeddings (PostgreSQL or in-memory)
3. At runtime: `retrieve_tools` with semantic query → relevant tool IDs via vector similarity
4. Only matched tools instantiated for the current run

**Dynamic tool calling** (August 2025): control which tools are available at different points in a run.

### CrewAI — Role-Based Distribution

- Manager agents oversee task distribution and tool selection
- Worker agents get tools assigned based on role
- Shared memory (short-term, long-term, entity, contextual) enables coordination

### Microsoft Semantic Kernel / Agent Framework

Three plugin import methods:
1. **Native code:** Class-based with `[KernelFunction]` attributes
2. **OpenAPI specification:** Import from any OpenAPI spec
3. **MCP Server:** Import tools directly from MCP servers

Unified **Microsoft Agent Framework** (October 2025): merged Semantic Kernel + AutoGen. Supports Agent Skills as file-based directories. Python SDK adds code-defined skills with script execution gated behind human approval.

### OpenAI Code Interpreter

Fully sandboxed container per session:
- Python execution in sandboxed containers
- Configurable memory (default 1GB)
- "Auto mode" reuses active containers across calls
- No shared tool layer across sessions

---

## Content-Addressable Storage (CAS)

### Git Object Store Model

SHA1-based CAS. Terragrunt's experimental CAS leverages this for tool deduplication:
- Objects at `~/.cache/terragrunt/cas/store/{hash[:2]}/{hash}`
- Hard links from CAS to target directories (no duplication)
- Cold clones: fetch, extract to CAS, hard-link to target
- Warm clones: verify hash exists, hard-link instantly (zero network)

### OCI Artifact Registries

OCI v1.1 (2024) extended registries to support arbitrary content types beyond container images.

- Content identified by immutable digests (content-addressable)
- `artifactType` property enables type discrimination
- **ORAS** (OCI Registry As Storage): standard CLI/library for push/pull
- Supported by Docker Hub, ECR, ACR, all major registries
- Already used for: Helm charts, WASM modules, OPA bundles, SBOMs, Bicep files

**Best candidate for skill package distribution** — existing infrastructure, content-addressable, immutable.

### XET Protocol (IETF Draft)

Content-addressable storage with chunk-level deduplication. Content-defined chunking, variable-sized chunks aggregated into "xorbs". IETF draft stage.

---

## Package Sharing Models for Sandboxes

### Nix Store

Strongest model for reproducible, shared tool installations:
- Each package at `/nix/store/{hash}-{name}-{version}`
- Content-addressed by build inputs (source, dependencies, build scripts)
- Sandboxed builds: network and filesystem restricted
- Multiple versions coexist without conflicts
- Flakes add reproducible dependency pinning with lock files
- 100,000+ packages in Nixpkgs

Maps directly to shared skill installations: each skill version gets a unique store path, multiple agents share the same read-only store via hard links.

### Flatpak's Shared Runtime Model

Directly relevant to skill sharing:
- **Shared runtimes:** Common library sets shared across applications
- **Read-only mounting:** Apps have no write access to runtimes
- **Deduplication:** Identical versions stored once, referenced by multiple apps
- **Sandboxing:** bubblewrap enforces filesystem and process isolation
- 20-40% faster startup than Snap due to deduplication

**Closest existing model to "shared read-only skill bundles across isolated agents."**

### Docker Multi-Stage Builds

- `COPY --link` creates independent layers rebased onto new base images
- BuildKit DAG parallelises independent stages, skips unused stages
- Layer caching enables shared base images with tool installations

---

## Security Models for Skill Mounting

| Level | Approach | Details |
|-------|----------|---------|
| Filesystem | Read-only bind mounts | Skills mounted read-only, agent writes only to designated areas |
| Process | gVisor / seccomp / AppArmor | Syscall filtering, reduced kernel attack surface |
| Machine | Firecracker / Kata | Hardware-level isolation, dedicated kernels |
| Network | Zero-trust egress | All outbound blocked by default, allowlisted per skill |
| Credential | Short-lived, scoped tokens | Task-specific credentials that expire |
| Approval | Human-in-the-loop gates | Script execution gated behind approval |
| Audit | Immutable trails | All skill invocations logged with full context |

The Agent Skills spec includes experimental `allowed-tools` field (e.g., `Bash(git:*) Bash(jq:*) Read`), but enforcement varies by agent implementation.

---

## Key Answers

### State of the Art for Shared Skill Bundles

Layered approach:
1. **Agent Skills standard** for skill format
2. **Filesystem-based delivery** into sandboxes (bind-mount or volume mount)
3. **Progressive disclosure** (metadata-only at startup)
4. **MCP servers** for dynamic capabilities

No production system yet combines CAS-based deduplication with skill distribution. Most practical path: package skills as OCI artifacts, use CAS locally, bind-mount read-only into sandboxes.

### Emerging Standards for Agent Skill Packages

**Agent Skills** is the format standard (30+ tools, 351K+ skills). **MCP** is the dynamic tool standard. **No standard yet** for the distribution/packaging layer. OCI artifacts and content-addressable registries are the likely foundation.

---

## Sources

- [Agent Skills Specification](https://agentskills.io/specification)
- [Anthropic: Agent Skills Open Standard](https://claude.com/blog/equipping-agents-for-the-real-world-with-agent-skills)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP 2026 Roadmap](http://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [LangGraph-BigTool](https://github.com/langchain-ai/langgraph-bigtool)
- [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [Terragrunt CAS](https://docs.terragrunt.com/features/cas)
- [ORAS Artifacts](https://oras.land/docs/concepts/artifact/)
- [OCI Artifacts Explained](https://oneuptime.com/blog/post/2025-12-08-oci-artifacts-explained/view)
- [Nix Package Manager](https://nixos.org/)
- [Flatpak Sandbox Permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
- [Agent Skills Marketplaces (SkillsMP)](https://skillsmp.com/)
- [Red Hat: Agent Skills Security](https://developers.redhat.com/articles/2026/03/10/agent-skills-explore-security-threats-and-controls)
