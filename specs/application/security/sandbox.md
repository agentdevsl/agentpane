# AgentPane Sandbox Specification

## Overview

The AgentPane Sandbox provides isolated execution environments for AI agents. The implementation supports a **multi-provider architecture** with 5 sandbox backends: Docker, DevContainer, Kubernetes, Nomad, and AWS Bedrock AgentCore. Each project can be assigned a named `SandboxConfig` that determines the provider type, resource limits, and provider-specific settings.

**Design Philosophy**: Defense in depth through container isolation, resource limits, credential injection, and git worktree isolation. The sandbox assumes agents execute untrusted code that must be constrained to designated workspaces.

> **Detailed sandbox architecture**: See `specs/sandbox/` for comprehensive architecture diagrams, isolation layers, SDK integration, and security documentation.

---

## Architecture

```text
+-----------------------------------------------------------------------+
|                           AgentPane Host                               |
+-----------------------------------------------------------------------+
|  SandboxService                                                        |
|  +-- SandboxProvider interface (pluggable)                             |
|  |   +-- DockerProvider (default)                                      |
|  |   |   +-- Docker Engine API via dockerode                           |
|  |   +-- AgentSandboxProvider (K8s / Nomad)                            |
|  |   |   +-- @kubernetes/client-node                                   |
|  |   |   +-- Nomad HTTP API                                           |
|  |   +-- AgentCoreSandboxProvider (AWS Bedrock)                        |
|  |       +-- SSE invoke + AgentCoreBridge                              |
|  +-- SandboxConfigService (CRUD for named configs)                     |
|  +-- ContainerAgentService (agent lifecycle in sandboxes)              |
|  +-- CredentialsInjector (OAuth/API key injection)                     |
|  +-- TmuxManager (per-task terminal sessions)                          |
+-----------------------------------------------------------------------+
|  Per-Agent Sandbox Instance                                            |
|  +-- Resource Limits (CPU, memory, PIDs, timeout)                      |
|  +-- Non-root User Execution                                          |
|  +-- Volume Mounts (project dirs bind-mounted to /workspace)           |
|  +-- Git Worktree Isolation (per-task branches)                        |
|  +-- Tmux Sessions (per-task terminal multiplexing)                    |
+-----------------------------------------------------------------------+
```

---

## Sandbox Providers

### Provider Types

```typescript
// src/db/schema/shared/enums.ts
export const SANDBOX_TYPES = [
  'docker',
  'devcontainer',
  'kubernetes',
  'nomad',
  'agentcore',
] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];
```

| Provider | Implementation | Use Case |
|----------|---------------|----------|
| `docker` | `DockerProvider` via dockerode | Local development, single-machine |
| `devcontainer` | DevContainer CLI integration | IDE-integrated development |
| `kubernetes` | `AgentSandboxProvider` via @kubernetes/client-node | Production multi-node clusters |
| `nomad` | `NomadSandboxProvider` via HTTP API | HashiCorp Nomad orchestration |
| `agentcore` | `AgentCoreSandboxProvider` via SSE invoke | AWS Bedrock AgentCore runtimes |

### Provider Interface

```typescript
// src/lib/sandbox/providers/sandbox-provider.ts

export interface SandboxProvider {
  readonly name: string;
  create(config: SandboxConfig): Promise<Sandbox>;
  get(projectId: string): Promise<Sandbox | null>;
  getById(sandboxId: string): Promise<Sandbox | null>;
  list(): Promise<SandboxInfo[]>;
  pullImage(image: string): Promise<void>;
  isImageAvailable(image: string): Promise<boolean>;
  healthCheck(): Promise<SandboxHealthCheck>;
  cleanup(options?: { olderThan?: Date; status?: string[] }): Promise<number>;
}

export interface Sandbox {
  readonly id: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly status: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

  exec(cmd: string, args?: string[]): Promise<ExecResult>;
  execAsRoot(cmd: string, args?: string[]): Promise<ExecResult>;
  execStream?(options: ExecStreamOptions): Promise<ExecStreamResult>;

  createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession>;
  listTmuxSessions(): Promise<TmuxSession[]>;
  killTmuxSession(sessionName: string): Promise<void>;
  sendKeysToTmux(sessionName: string, keys: string): Promise<void>;
  captureTmuxPane(sessionName: string, lines?: number): Promise<string>;

  stop(): Promise<void>;
  getMetrics(): Promise<SandboxMetrics>;
  touch(): void;
  getLastActivity(): Date;
}
```

---

## SandboxConfig Table

Named sandbox configurations are stored in the `sandbox_configs` table and assigned to projects. This allows multiple projects to share a configuration or each project to have its own.

```typescript
// src/db/schema/sqlite/sandbox-configs.ts

export const sandboxConfigs = sqliteTable('sandbox_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type', { enum: SANDBOX_TYPES }).notNull().default('docker'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  baseImage: text('base_image').notNull().default('node:22-slim'),
  memoryMb: integer('memory_mb').notNull().default(4096),
  cpuCores: real('cpu_cores').notNull().default(2.0),
  maxProcesses: integer('max_processes').notNull().default(256),
  timeoutMinutes: integer('timeout_minutes').notNull().default(60),
  volumeMountPath: text('volume_mount_path'),

  // Kubernetes-specific fields
  kubeConfigPath: text('kube_config_path'),
  kubeContext: text('kube_context'),
  kubeNamespace: text('kube_namespace').default('agentpane-sandboxes'),
  networkPolicyEnabled: integer('network_policy_enabled', { mode: 'boolean' }).default(true),
  allowedEgressHosts: text('allowed_egress_hosts', { mode: 'json' }).$type<string[]>(),

  // Nomad-specific fields
  nomadAddress: text('nomad_address'),
  nomadToken: text('nomad_token'),       // Encrypted at rest via server-encryption
  nomadNamespace: text('nomad_namespace').default('default'),
  nomadDatacenter: text('nomad_datacenter'),
  nomadRegion: text('nomad_region'),

  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});
```

### SandboxConfigService

The `SandboxConfigService` (`src/services/sandbox-config.service.ts`) provides CRUD operations for sandbox configs with:

- **Resource limit validation**: memory 512-32768 MB, CPU 0.5-16 cores, processes 32-4096, timeout 1-1440 min
- **Name uniqueness enforcement**
- **Single default config**: setting a new default clears the previous one
- **In-use protection**: configs assigned to projects cannot be deleted
- **Nomad token encryption**: tokens encrypted at rest with `encryptToken()`, decrypted on read

---

## SandboxService

The `SandboxService` (`src/services/sandbox.service.ts`) manages sandbox lifecycle:

### Key Operations

| Method | Description |
|--------|-------------|
| `getOrCreateForProject(projectId)` | Get running sandbox or create one from project config |
| `create(config)` | Create container, inject credentials, store in DB |
| `stop(sandboxId, reason)` | Kill tmux sessions, stop container, update DB |
| `createTmuxSessionForTask(projectId, taskId)` | Create isolated tmux session for a task |
| `exec(sandboxId, command, args)` | Execute command in sandbox |
| `getMetrics(sandboxId)` | Get CPU/memory/disk metrics |
| `refreshCredentials(sandboxId)` | Re-inject credentials after rotation |
| `healthCheck()` | Provider health check |

### Idle Sandbox Cleanup

A background timer checks every 5 minutes for idle sandboxes. If a sandbox has been idle beyond its `idleTimeoutMinutes`, it is automatically stopped. The checker disables itself after 5 consecutive failures.

### Events Published

| Event | When |
|-------|------|
| `sandbox:creating` | Sandbox creation started |
| `sandbox:ready` | Container running and credentials injected |
| `sandbox:error` | Creation or stop failed |
| `sandbox:idle` | Sandbox exceeded idle timeout |
| `sandbox:stopping` | Stop initiated (manual, idle, or error) |
| `sandbox:stopped` | Container stopped successfully |
| `sandbox:tmux:created` | New tmux session created |

---

## Container Agent Execution Flow

The `ContainerAgentService` (`src/services/container-agent.service.ts`) orchestrates agent execution inside sandbox containers and AgentCore runtimes.

### Execution Phases

```typescript
export type AgentPhase = 'plan' | 'execute';
```

### Startup Stages

The UI displays progress through these stages:

```typescript
type ContainerAgentStage =
  | 'initializing'     // Validating configuration
  | 'validating'       // Checking project and sandbox settings
  | 'credentials'      // Configuring authentication
  | 'creating_sandbox' // Creating/reusing container
  | 'executing'        // Starting agent-runner process
  | 'running';         // Agent actively working
```

### Execution Paths

The service supports two execution paths depending on the sandbox provider:

1. **Container exec path** (Docker, Kubernetes, Nomad): Runs `agent-runner` inside the container via `execStream()`. Events are captured from stdout via `ContainerBridge`.

2. **AgentCore path** (AWS Bedrock): Invokes via SSE HTTP endpoint. Events are captured via `AgentCoreBridge`.

### Plan-Execute Flow

1. Task moved to `in_progress` triggers `startAgent(phase: 'plan')`
2. Agent explores codebase in plan mode, produces implementation plan
3. Plan captured when agent calls `ExitPlanMode` tool
4. Plan stored with `sdkSessionId` for session continuity
5. User reviews and approves/rejects plan
6. On approval: `startAgent(phase: 'execute', sdkSessionId)` resumes execution

### Remote Workspace Initialization (K8s / Nomad)

When using Kubernetes or Nomad providers, the workspace is initialized remotely:
- Clone the project repository into `/workspace` via `initializeRemoteWorkspaceInPod()`
- Create a git worktree for the specific task branch
- Resolve GitHub tokens via `git-token-resolver` for authenticated clones

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/services/sandbox.service.ts` | Sandbox lifecycle (create, stop, idle cleanup) |
| `src/services/sandbox-config.service.ts` | Named config CRUD with validation |
| `src/services/container-agent.service.ts` | Agent execution orchestration |
| `src/lib/sandbox/providers/sandbox-provider.ts` | Provider interface |
| `src/lib/sandbox/providers/docker-provider.ts` | Docker implementation |
| `src/lib/sandbox/providers/agent-sandbox-provider.ts` | K8s/Nomad implementation |
| `src/lib/sandbox/providers/agentcore-sandbox-provider.ts` | AWS AgentCore implementation |
| `src/lib/sandbox/providers/nomad-sandbox-provider.ts` | Nomad-specific provider |
| `src/lib/sandbox/credentials-injector.ts` | Credential injection into containers |
| `src/lib/sandbox/tmux-manager.ts` | Tmux session management |
| `src/lib/sandbox/types.ts` | Shared types and defaults |
| `src/lib/sandbox/k8s-workspace-initializer.ts` | Remote workspace setup |
| `src/lib/sandbox/git-token-resolver.ts` | GitHub token resolution for clones |
| `agent-runner/src/index.ts` | Agent process inside container |
| `agent-runner/src/event-emitter.ts` | Structured event output from container |
| `docker/Dockerfile.agent-sandbox` | Docker image for sandboxes |
| `docker/entrypoint.sh` | Container entrypoint with permission fixes |

---

## Container Security

- **Non-root execution**: Runs as `node` user inside containers
- **Volume mounts**: Project directories bind-mounted to `/workspace`
- **Git safe directory**: `safe.directory '*'` for mounted volumes
- **Limited sudo**: Only for permission fixes during entrypoint
- **Credential injection**: OAuth tokens written to `~/.claude/.credentials.json`
- **Environment filtering**: Sensitive vars stripped via `buildSdkEnv()` blocklist
- **Idle timeout**: Automatic cleanup of inactive containers

---

## Defaults

```typescript
// src/lib/sandbox/types.ts
export const SANDBOX_DEFAULTS = {
  image: 'srlynch1/agent-sandbox:latest',
  memoryMb: 4096,
  cpuCores: 2,
  idleTimeoutMinutes: 30,
  userHome: '/home/node',
} as const;
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [specs/sandbox/](../../sandbox/README.md) | Detailed sandbox architecture, isolation layers, SDK integration |
| [Claude Agent SDK](../integrations/claude-agent-sdk.md) | SDK usage inside sandboxes |
| [Database Schema](../database/schema.md) | SandboxConfig, SandboxInstance tables |
| [Error Catalog](../errors/error-catalog.md) | SandboxError types |
| [Authentication](./authentication.md) | Credential injection from OAuth tokens |
| [Git Worktrees](../integrations/git-worktrees.md) | Per-task filesystem isolation |
| [Durable Sessions](../integrations/durable-sessions.md) | Real-time sandbox event streaming |
