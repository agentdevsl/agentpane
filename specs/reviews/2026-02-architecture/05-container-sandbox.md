# 05 - Container & Sandbox Architecture Review

**Date**: 2026-02-17
**Scope**: Docker sandbox, Kubernetes CRD controller, agent-runner, security isolation, workspace initialization
**Status**: Complete

---

## 1. Overview

AgentPane provides sandboxed agent execution through two container providers -- Docker (local development) and Kubernetes (production CRD-based). The architecture follows a layered design:

```
ContainerAgentService          (orchestration)
  -> SandboxProvider           (provider abstraction)
     -> DockerProvider         (Docker via dockerode)
     -> AgentSandboxProvider   (K8s via @agentpane/agent-sandbox-sdk)
  -> ContainerBridge           (stdout JSON-line parsing, DurableStreams bridging)
  -> agent-runner              (Claude SDK session inside container)
```

The system supports a plan-then-execute workflow: agents first run in `permissionMode: 'plan'` (read-only), produce a plan, and after user approval, run in `permissionMode: 'bypassPermissions'` for execution. Workspace isolation is provided through git worktrees (Docker) or in-pod clone + worktree (K8s).

**Overall Assessment**: The container sandbox architecture is well-designed with thoughtful abstractions. The provider interface allows clean swapping between Docker and K8s backends. The plan/execute separation provides a meaningful security boundary. Several areas warrant attention around credential handling, race conditions in state management, and gaps in the K8s security model.

---

## 2. Docker Sandbox

### 2.1 Dockerfile.agent-sandbox

**File**: `docker/Dockerfile.agent-sandbox`

The sandbox image extends a base `terraform-ai-tools` image with:
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Agent runner built from TypeScript source
- ripgrep, fd-find, tree for file operations
- Git configured with `safe.directory '*'`

The image runs as non-root `node` user (line 74), with workspace at `/workspace` and `.claude` directories pre-created.

### 2.2 Docker Provider

**File**: `src/lib/sandbox/providers/docker-provider.ts`

The Docker provider uses `dockerode` to manage container lifecycle. Key behaviors:
- Containers are created per-project with bind-mounted project directories
- Exec operations use Docker's multiplexed stdout/stderr protocol (8-byte headers)
- Streaming exec (`execStream`) provides real-time output for the container bridge
- Containers are tracked in-memory with a `sandboxes` Map and `projectToSandbox` index

### 2.3 Entrypoint Script

**File**: `docker/entrypoint.sh`

The entrypoint fixes `/workspace` permissions for bind-mounted volumes via `sudo chown` (line 10), then exec's the passed command. This handles the common case where host UIDs don't match the container's `node` user.

### 2.4 Build Script

**File**: `docker/build-agent-sandbox.sh`

Straightforward build script that runs `npm install && npm run build` in agent-runner, then builds the Docker image. The image name defaults to `agentpane/agent-sandbox:latest`.

---

## 3. Kubernetes CRD Controller

### 3.1 AgentSandboxProvider

**File**: `src/lib/sandbox/providers/agent-sandbox-provider.ts`

The K8s provider implements the same `SandboxProvider` interface as Docker, using a CRD-based approach via `@agentpane/agent-sandbox-sdk`. Key features:
- Creates Sandbox CRD resources; the controller reconciles them into pods
- In-memory cache (`sandboxes` + `projectToSandbox` Maps) with cluster fallback queries
- Warm pool support via `SandboxWarmPool` CRD (lines 449-485)
- DNS-1123 compliant sandbox naming (line 132-134)
- Runtime class support for gVisor/Kata isolation (lines 157-159)
- Health check queries CRD registration, namespace existence, and controller status

### 3.2 AgentSandboxInstance

**File**: `src/lib/sandbox/providers/agent-sandbox-instance.ts`

Wraps a Sandbox CRD resource with the `Sandbox` interface. Notable:
- `execStream` builds shell commands with cwd handling, matching Docker's pattern (line 114-205)
- Environment variables in K8s exec are injected via shell prefixes since K8s exec doesn't support env natively (lines 136-173)
- Env key validation prevents command injection (`ENV_KEY_PATTERN` at line 139)
- `execAsRoot` is a no-op (logs warning, runs as default user) since CRD pods run non-root (line 71-77)
- Status refresh queries the actual CRD phase from the cluster (line 366-378)
- Full tmux session management (create, list, kill, send-keys, capture-pane)

### 3.3 CRD Controller

**File**: `src/lib/sandbox/controllers/sandbox-controller.ts`

A reconciliation controller that watches Sandbox CRDs and creates corresponding pods:
- **Watch handler**: Reacts to ADDED/MODIFIED events by reconciling sandboxes (line 130-159)
- **Pod builder**: Generates V1Pod from Sandbox CRD spec, with ownerReferences for GC cascade (line 279-358)
- **Security context**: Enforces restricted PSS -- `runAsNonRoot`, `runAsUser: 1000`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]` (lines 347-353, 379-395)
- **Status sync**: Periodic timer pushes pod status back to CRD status subresource (lines 421-504)
- **Warm pool reconciliation**: Creates new Sandbox CRDs to fill deficits, cleans up terminal sandboxes (lines 535-640)
- **Template resolution**: Supports `sandboxTemplateRef` for reusable pod specs (line 212-233)
- **Terminal pod recovery**: Deletes Failed/Succeeded pods for recreation (lines 184-194)

### 3.4 K8s Workspace Initializer

**File**: `src/lib/sandbox/k8s-workspace-initializer.ts`

Handles git clone + worktree setup inside K8s pods:
- Shallow clone with `--no-single-branch` to keep branch refs available (line 98-100)
- Token embedded in clone URL, then stripped immediately after clone (lines 89, 115-128)
- Credential helper explicitly disabled to prevent persistence (lines 131-142)
- Branch name sanitized via `slugify()` (line 265)
- Graceful fallback: clone failure falls back to empty `/workspace`; worktree failure falls back to clone root

---

## 4. Agent Runner

### 4.1 Entry Point

**File**: `agent-runner/src/index.ts`

The agent-runner is the process that executes inside containers. It:

1. Validates environment variables (lines 167-189)
2. Writes OAuth credentials to `~/.claude/.credentials.json` (lines 196-242)
3. Routes to planning or execution phase based on `AGENT_PHASE`
4. Creates Claude Agent SDK sessions with appropriate permission modes
5. Processes the SDK stream, emitting JSON-line events to stdout for the host bridge

**Planning phase** (lines 311-663):
- Uses `permissionMode: 'plan'` (line 403)
- Captures `ExitPlanMode` tool calls via `canUseTool` callback (lines 365-396)
- Has a 60-second timeout for ExitPlanMode processing (line 330, 446-461)
- Emits `agent:plan_ready` event with plan content and SDK session ID

**Execution phase** (lines 670-991):
- Uses `permissionMode: 'bypassPermissions'` (line 744, 769)
- Attempts session resume via `unstable_v2_resumeSession` if SDK session ID provided (lines 741-748)
- Falls back to fresh session on resume failure (lines 749-760)
- Tracks file modifications (Write, Edit, NotebookEdit tools) and emits `agent:file_changed` events (lines 37-72)

**Path security**:
- `resolveWorkspacePath` constrains `AGENT_CWD` to `/workspace` subtree (lines 244-253)
- `resolveStopFilePath` constrains sentinel files to `/workspace` or `/tmp` (lines 255-268)

### 4.2 Event Emitter

**File**: `agent-runner/src/event-emitter.ts`

Defines 11 event types for container-to-host communication via JSON lines on stdout:
- Critical events (`started`, `complete`, `error`, `plan_ready`) use `writeSync()` for immediate delivery (bypasses Node stream buffering)
- High-frequency events (`token`) use async `process.stdout.write()` for performance
- The `EventEmitter` class emits structured `AgentEvent` objects with `type`, `timestamp`, `taskId`, `sessionId`, and `data`

### 4.3 Custom Tool Registry

**File**: `agent-runner/src/tools/index.ts`

Defines custom tools (`read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`) for the agent-runner. Note: these tools exist but are NOT used in the current agent-runner flow since the SDK's built-in tools are used via `canUseTool` callbacks. The tool registry appears to be a leftover from an earlier architecture where tools were manually invoked.

### 4.4 Bash Tool Security

**File**: `agent-runner/src/tools/bash-tool.ts`

The bash tool (if used) includes:
- Dangerous command pattern blocking (rm -rf /, git push --force, DROP TABLE, etc.) at lines 23-35
- Workspace path confinement (lines 44-53)
- Configurable timeout with min/max bounds (lines 55-62)

---

## 5. Security Model

### 5.1 Container Isolation

| Layer | Docker | K8s |
|-------|--------|-----|
| User | Non-root `node` (UID 1000) | Non-root (UID 1000) via pod securityContext |
| Privilege escalation | Limited sudo for `chown` only | `allowPrivilegeEscalation: false` |
| Capabilities | Inherited from container runtime | `drop: ["ALL"]` |
| Seccomp | Default (Docker daemon profile) | `RuntimeDefault` |
| Runtime isolation | Standard runc | Configurable: runc, gVisor, Kata |
| Network | Docker network (no explicit policy) | Per-sandbox via CRD controller |
| Filesystem | Bind-mounted project directory | Ephemeral pod storage + clone |

### 5.2 Credential Security

- OAuth tokens passed via `CLAUDE_OAUTH_TOKEN` environment variable to the container
- Agent-runner writes credentials to `~/.claude/.credentials.json` with mode `0o600` (line 226 of agent-runner index.ts)
- The `.claude` directory is created with mode `0o700` (line 223)
- Git clone tokens are stripped from remote URLs immediately after clone (k8s-workspace-initializer.ts:115-128)
- Credential helper is disabled to prevent token persistence (k8s-workspace-initializer.ts:131-142)
- `CredentialsInjector` uses base64 encoding to prevent command injection during credential writes (credentials-injector.ts:75-79)

### 5.3 Plan/Execute Security Boundary

The two-phase execution model provides a meaningful security layer:
1. **Planning**: `permissionMode: 'plan'` -- agent can explore but the SDK restricts writes
2. **User approval**: Human reviews the plan before execution
3. **Execution**: `permissionMode: 'bypassPermissions'` -- full access granted

---

## 6. Authentication in Containers

### 6.1 OAuth Token Flow

```
Admin Settings / Env Var
  -> ApiKeyService.getDecryptedKey('anthropic')
     -> ContainerAgentService.startAgent() stores in env
        -> agent-runner receives CLAUDE_OAUTH_TOKEN
           -> Writes to ~/.claude/.credentials.json
              -> SDK reads credentials file for API auth
```

### 6.2 Git Authentication Flow

```
Project (githubOwner, githubRepo, githubInstallationId)
  -> resolveGitToken()
     1. Try GitHub App installation token (via Octokit)
     2. Fallback to Personal Access Token (via GitHubTokenService)
     3. Return null (agent works in empty workspace)
```

### 6.3 CredentialsInjector (Legacy Path)

**File**: `src/lib/sandbox/credentials-injector.ts`

A separate credentials injection mechanism that loads host credentials from `~/.claude/.credentials.json` and writes them into containers. This appears to be an older path; the current `ContainerAgentService` passes OAuth tokens via environment variables to the agent-runner, which writes its own credentials file. Both paths coexist.

---

## 7. Status Tracking

### 7.1 Breadcrumb Stages

**File**: `src/app/components/features/container-agent-panel/container-agent-status-breadcrumbs.tsx`

The UI displays a 6-stage progress breadcrumb:

```
Initializing -> Validating -> Credentials -> Creating Sandbox -> Executing -> Running
```

Each stage is mapped to a visual state:
- **Pending**: Muted gray icon with step number
- **Active**: Blue pulsing icon with spinner
- **Complete**: Green checkmark icon

Stage transitions are published via DurableStreams events (`container-agent:status`) and tracked in a `statusHistory` array.

### 7.2 Event-Based Progress

The `ContainerAgentService` publishes status events at each stage transition:
- `container-agent:status` -- stage + message for breadcrumbs
- `container-agent:message` -- human-readable log messages for the session view
- `container-agent:started` -- agent execution began (includes model, maxTurns, provider)
- `container-agent:complete` / `container-agent:error` -- terminal events

### 7.3 Container Bridge

**File**: `src/lib/agents/container-bridge.ts`

The bridge reads JSON lines from the agent-runner's stdout, maps event types to DurableStreams types (e.g., `agent:complete` -> `container-agent:complete`), and publishes them. It also processes stderr for fallback error events (lines 406-462).

---

## 8. Findings

### CS-001: OAuth Token Exposed in Container Environment Variables

**Severity**: Medium
**Files**: `src/services/container-agent.service.ts:1239`, `agent-runner/src/index.ts:79`

The OAuth token is passed to the container via the `CLAUDE_OAUTH_TOKEN` environment variable. While the `prepareContainerExec` method at line 614 redacts the token from debug logs (`CLAUDE_OAUTH_TOKEN: '[REDACTED]'`), the actual token is still passed in the `env` parameter at line 1239. In Docker, environment variables can be inspected via `docker inspect` by anyone with Docker socket access. In K8s, environment variables are visible in pod specs.

**Recommendation**: Consider using a Kubernetes Secret mounted as a file volume, or Docker secrets, rather than passing the token as an environment variable. This would prevent exposure via container inspection and align with security best practices for secret injection.

---

### CS-002: In-Memory State Not Synchronized Across Server Restarts

**Severity**: Medium
**Files**: `src/services/container-agent.service.ts:152-155`

The `runningAgents` Map (line 152) and `pendingPlans` Map (line 155) are in-memory only. On server restart, all running agent tracking is lost. While `pendingPlans` has DB recovery (lines 2038-2068), `runningAgents` does not -- orphaned agent processes in containers will continue running without host-side tracking.

**Recommendation**: Implement an orphan detection mechanism on startup that queries running containers/pods for active agent-runner processes and re-attaches or terminates them. The `startingAgents` Set (line 158) has the same issue and should also be considered.

---

### CS-003: TOCTOU Race Between Sandbox Validation and Exec

**Severity**: Low
**Files**: `src/services/container-agent.service.ts:1219-1232`

There is a time-of-check-to-time-of-use (TOCTOU) gap between validating the sandbox is running and executing the agent-runner. The code has a mitigation at lines 1219-1232 (`refreshStatus` guard), but only if the sandbox implementation provides `refreshStatus`. The Docker provider does not expose this method on its sandbox instances, leaving a small window where the container could stop between validation and exec.

**Recommendation**: This is a low-risk issue since container disappearance mid-operation is uncommon. The existing error handling in the `try/catch` at line 1317 provides adequate fallback. For defense-in-depth, ensure the Docker sandbox also implements `refreshStatus`.

---

### CS-004: Agent-Runner Tool Registry Unused

**Severity**: Low
**Files**: `agent-runner/src/tools/index.ts`, `agent-runner/src/tools/bash-tool.ts`, `agent-runner/src/tools/file-tools.ts`, `agent-runner/src/tools/search-tools.ts`

The agent-runner contains a custom tool registry with 6 tool definitions (`read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`) that are never used in the current agent-runner flow. The `index.ts` entry point uses the Claude Agent SDK's built-in tools via `canUseTool` callbacks, not the custom tools. This is dead code that increases the attack surface and maintenance burden.

**Recommendation**: Remove the unused tool registry and its implementations if they are confirmed not to be used. If they are intended for a future custom-tool integration, document the intent clearly.

---

### CS-005: Credentials File Verification Reads Back the File

**Severity**: Low
**Files**: `agent-runner/src/index.ts:231-241`

After writing the credentials file, the agent-runner reads it back and parses it to verify correctness (lines 231-241). While this is defensive programming, it creates a brief window where the file is readable in memory as a parsed JSON object with the `accessToken` field. In a compromised container, a memory dump during this window could expose the token.

**Recommendation**: This is low-risk given the container is already trusted with the token. The verification step is a reasonable integrity check. No immediate action needed, but consider removing the verification read in production builds if memory-safety is a concern.

---

### CS-006: K8s Env Vars Passed via Shell Interpolation Without Full Sanitization

**Severity**: Medium
**Files**: `src/lib/sandbox/providers/agent-sandbox-instance.ts:136-173`

When executing commands with environment variables in K8s pods, the `execStream` method builds shell strings with env var values passed through `shellEscape()` (single-quote wrapping). While env key validation prevents key injection (line 139-143), the shell command construction at lines 148-172 has complex branching:

- In the `sh -c` path: env vars are injected before `exec` inside the shell string (line 155-159)
- In the non-shell path: env vars are passed as `env` command arguments WITHOUT shell escaping (line 171), which is correct since they are argv entries, not shell-interpolated

However, the `export` fallback path at line 163 uses `shellEscape` inside a shell string, which could be problematic if the shell string itself is not properly escaped in edge cases.

**Recommendation**: Add integration tests that exercise the env-var injection paths with adversarial values (single quotes, backticks, dollar signs, newlines) to validate the escaping is correct across all branches.

---

### CS-007: No Network Policy for Docker Containers

**Severity**: Medium
**Files**: `docker/docker-compose.yml`, `src/lib/sandbox/providers/docker-provider.ts`

Docker sandbox containers have no network isolation. An agent running in a Docker container can make arbitrary network requests, potentially exfiltrating data or accessing internal services. The K8s provider benefits from CRD-managed network policies, but the Docker provider has no equivalent.

**Recommendation**: Consider creating a dedicated Docker network with restricted egress (allow only Anthropic API endpoints) for sandbox containers. Docker's `--network` option with custom bridge networks and iptables rules can provide similar isolation to K8s network policies.

---

### CS-008: Hardcoded Default Image in Multiple Locations

**Severity**: Low
**Files**: `src/lib/sandbox/types.ts:117`, `src/lib/sandbox/controllers/sandbox-controller.ts:30`

The default sandbox image is defined in two places:
- `SANDBOX_DEFAULTS.image = 'srlynch1/agent-sandbox:latest'` at `types.ts:117`
- `DEFAULT_SANDBOX_IMAGE = 'srlynch1/agent-sandbox:latest'` at `sandbox-controller.ts:30`

This duplication can lead to drift if one is updated without the other.

**Recommendation**: Have the controller import and use `SANDBOX_DEFAULTS.image` from `types.ts` instead of maintaining its own constant.

---

### CS-009: Warm Pool Reconciliation Uses Math.random() for Naming

**Severity**: Low
**Files**: `src/lib/sandbox/controllers/sandbox-controller.ts:782-788`

The `randomString()` method at line 782 uses `Math.random()` for generating warm pool sandbox name suffixes. While this is not a cryptographic context and collisions are handled (line 619 catches `AlreadyExistsError`), using a non-cryptographic RNG for resource naming in a multi-controller environment could lead to rare collisions.

**Recommendation**: Consider using `crypto.randomUUID()` or the existing `@paralleldrive/cuid2` for generating suffixes, consistent with how sandbox IDs are generated elsewhere in the codebase (e.g., `agent-sandbox-provider.ts:130`).

---

### CS-010: Status Patching Uses GET+PUT Instead of PATCH

**Severity**: Low
**Files**: `src/lib/sandbox/controllers/sandbox-controller.ts:653-681`

The `patchSandboxStatus` method uses a GET + full object replace (PUT) pattern instead of a proper JSON merge-patch. This creates a read-modify-write race condition: if another process updates the status between the GET and PUT, those changes are lost.

**Recommendation**: Use the K8s `customApi.patchNamespacedCustomObjectStatus` with `application/merge-patch+json` content type instead. The comment at line 655-657 acknowledges this was done due to content-type difficulties; the `@kubernetes/client-node` library's `options` parameter supports custom headers that can set the correct Content-Type.

---

### CS-011: Docker Compose Uses Hardcoded Postgres Credentials

**Severity**: Low (Development Only)
**Files**: `docker/docker-compose.postgres.yml:10-12`

The Postgres compose file uses hardcoded credentials (`POSTGRES_PASSWORD: agentpane_dev`). This is acceptable for local development but should be flagged to ensure it is never used in production deployments.

**Recommendation**: Add a prominent comment noting this is development-only, and ensure production deployments use secret injection.

---

### CS-012: Plan TTL Cleanup May Leave Orphaned Worktrees

**Severity**: Medium
**Files**: `src/services/container-agent.service.ts:670-688`

When `cleanupExpiredPlans()` deletes a pending plan after the 1-hour TTL (lines 670-688), it does not clean up the associated worktree. The worktree was created during planning and linked to the task, but if the plan expires without approval or rejection, the worktree persists on disk.

**Recommendation**: Add worktree cleanup to the `cleanupExpiredPlans` method. Query the task record for `worktreeId` and call `cleanupWorktree()` before deleting from `pendingPlans`.

---

### CS-013: Agent-Runner Logs Token Presence to stderr

**Severity**: Low
**Files**: `agent-runner/src/index.ts:203-204`

The agent-runner logs `Token received: YES` to stderr at line 204. While this does not leak the actual token value, it confirms token presence in container logs. In a multi-tenant environment, container logs may be aggregated and visible to operators who should not know whether specific tokens are in use.

**Recommendation**: Remove the token presence log line or gate it behind a debug-only flag (it is already in a debug context but uses `console.error` which always writes).

---

### CS-014: Container Bridge Does Not Validate Event Data Schema

**Severity**: Low
**Files**: `src/lib/agents/container-bridge.ts:138-188`

The container bridge parses JSON lines from stdout and validates basic structure (has `type`, `timestamp`, `taskId`, `sessionId` at line 152), but does not validate that `event.data` matches the expected schema for each event type. A malicious or buggy agent-runner could emit events with unexpected data shapes that are published directly to DurableStreams.

**Recommendation**: Add per-event-type schema validation (e.g., verify `agent:complete` data has `status` in expected enum values and numeric `turnCount`) before publishing. The `handleComplete` and `handleError` functions already do partial validation; extend this to `publishEvent`.

---

### CS-015: Production Dockerfile Copies Full src/ Directory

**Severity**: Low
**Files**: `docker/Dockerfile:45`

The production Dockerfile at line 45 copies `src/` into the runtime image. For a compiled application, this may include TypeScript source files, test files, and development-only code that increases image size and attack surface.

**Recommendation**: Review whether the runtime actually needs `src/`. If the application is compiled to `dist/`, only copy `dist/` and remove the `src/` copy. If TanStack Start requires `src/` at runtime, consider a `.dockerignore` that excludes test files and non-essential sources.

---

### CS-016: Sudo Access in Agent Sandbox for chown

**Severity**: Low
**Files**: `docker/Dockerfile.agent-sandbox:64`

The sandbox image grants the `node` user passwordless sudo for `/bin/chown` (line 64). While limited to a single command, an agent could potentially use this to change ownership of sensitive files within the container (e.g., other users' files if any exist).

**Recommendation**: This is an acceptable tradeoff for handling bind-mount permission issues. Consider documenting the security rationale and ensuring the entrypoint only uses it for `/workspace`.

---

## 9. Architecture Strengths

1. **Clean provider abstraction**: The `SandboxProvider` interface allows Docker and K8s backends to be swapped transparently, with consistent behavior for `ContainerAgentService`.

2. **Plan/Execute two-phase model**: Separating planning (read-only) from execution (full permissions) with human approval in between provides a meaningful security checkpoint.

3. **Robust error handling**: The codebase consistently uses `Result<T, E>` types for error propagation, graceful fallbacks on worktree failures, and non-critical error continuation.

4. **Event-driven communication**: The JSON-line event protocol between agent-runner and container bridge, with sync/async write modes and stderr fallback, is well-designed for reliability.

5. **CRD-based K8s management**: Using custom resources with a reconciliation controller is the idiomatic Kubernetes pattern, enabling declarative management, GC via ownerReferences, and warm pool support.

6. **Credential hygiene in K8s**: Git tokens are stripped from remote URLs immediately after clone, and credential helpers are disabled to prevent persistence.

7. **Concurrent start protection**: The `startingAgents` Set (line 158) prevents race conditions from concurrent `startAgent` calls for the same task.

---

## 10. Summary

The container sandbox architecture is mature and well-structured. The primary areas of concern are:

| Priority | Finding | Impact |
|----------|---------|--------|
| Medium | CS-001: OAuth token in env vars | Credential exposure via container inspection |
| Medium | CS-002: In-memory state loss on restart | Orphaned agent processes |
| Medium | CS-007: No Docker network isolation | Unrestricted network access from containers |
| Medium | CS-012: Plan TTL cleanup skips worktrees | Disk space leak |
| Medium | CS-006: Shell injection edge cases | Potential command injection in K8s exec |
| Low | CS-003 to CS-005, CS-008 to CS-011, CS-013 to CS-016 | Minor improvements |

The K8s CRD controller follows Kubernetes best practices with proper security contexts, ownerReferences, and warm pool management. The Docker path is simpler but lacks the network isolation provided by K8s. The agent-runner's event protocol is reliable with sync writes for critical events and stderr fallback for error delivery.
