# 02 - Agent Execution and Sandbox Providers

## Verdict

Agent execution and sandboxing are substantially safer than the April baseline. Default image pinning is in place, provider recovery exists, current Docker/K8s/Nomad credential paths use `writeFile`, and host-mode plan approval resumed better than before. The remaining problems are concentrated at boundaries: K8s isolation order, multi-tenant fail-closed behavior, sandbox creation ownership, and plan approval permission scope.

## Findings

### MAY-02 - P0 - K8s network isolation can fail open

`AgentSandboxProvider.create()` creates the Sandbox CRD first (`src/lib/sandbox/providers/agent-sandbox-provider.ts:286`) and then creates the default-deny NetworkPolicy if isolation is enabled (`src/lib/sandbox/providers/agent-sandbox-provider.ts:294`). If policy creation fails, the catch path emits an error and throws (`src/lib/sandbox/providers/agent-sandbox-provider.ts:330`) but does not delete the CRD it already created.

Impact: a sandbox pod can exist without the intended network policy. In a hosted or untrusted-agent K8s deployment, this is a release blocker.

Recommendation: create the default-deny policy before creating the sandbox, or track `created=true` and delete the CRD on any post-create failure. Add a regression test where policy creation throws.

### MAY-03 - P0 conditional - Multi-tenant credential safety is opt-in

Credential injection and container execution gate shared sandbox mode only when `MULTI_TENANT=true` (`src/lib/sandbox/credentials-injector.ts:63`, `src/services/container-agent/container-exec.service.ts:316`). `isMultiTenantEnabled()` returns true only for the exact string `true` (`src/server/bootstrap/server-config.ts:127`).

Impact: if a deployment becomes multi-tenant without setting this one env var, a shared sandbox can receive the global Claude OAuth file. The code comments document this as a deliberate self-hosted compatibility tradeoff, but the failure mode is severe.

Recommendation: derive enforcement from tenant/auth configuration and sandbox mode, not a manually set flag. In any deployment with multiple teams/users and shared sandbox mode, fail closed before credentials can be injected.

### MAY-09 - P1 - Container auto-create bypasses configured sandbox policy

When no sandbox exists, `ContainerExecService` directly calls `provider.create()` with `SANDBOX_DEFAULTS` (`src/services/container-agent/container-exec.service.ts:354`) instead of routing through the same config/profile/quota path used elsewhere (`src/services/sandbox.service.ts:156`, `src/services/codespace.service.ts:160`).

Impact: agent execution can run with a different image, resource profile, timeout, quota behavior, or volume policy than the codespace/sandbox settings imply.

Recommendation: centralize sandbox creation in one resolver/service that always applies `sandboxConfigId`, defaults, quotas, image validation, and volume policy.

### MAY-10 - P1 - Agent error handling can strand tasks

`updateTaskOnAgentError()` leaves the task in `in_progress` and clears `agentId`, setting only `lastAgentStatus='error'` (`src/services/container-agent/shared-helpers.ts:223`). The error path calls it, cleans the worktree, updates the agent, then deletes the in-memory running agent (`src/services/container-agent/container-exec.service.ts:1398`). Startup reconciliation later moves orphaned `in_progress` tasks (`src/services/container-agent/container-agent.service.ts:280`), but that does not help an active process after a runtime error.

Impact: users can see a task remain in progress with no live agent attached.

Recommendation: on terminal agent error, move the task to a recoverable column such as `waiting_approval` or `backlog`, with explicit error metadata. Use a CAS/terminal-state guard to avoid racing the process-exit completion path.

### MAY-13 - P1 - Duplicate prevention is still process-local before provider create

K8s and Nomad duplicate prevention checks in-memory maps/sets before provider provisioning (`src/lib/sandbox/providers/agent-sandbox-provider.ts:232`, `src/lib/sandbox/providers/nomad-sandbox-provider.ts:187`). The DB uniqueness constraint happens after provisioning through higher-level service paths.

Impact: in multi-process or retry scenarios, duplicate pods/jobs can be created before the database rejects or observes the conflict.

Recommendation: reserve an active `sandbox_instances` row before provider create, then provision. On cache miss, probe the provider/cluster before creating a new sandbox.

### MAY-27 - P1 - Plan approval grants are too broad

The plan flow captures `allowedPrompts`, but execution still trends toward broad permission modes (`acceptEdits` / `bypassPermissions`) rather than converting the approved prompt list into bounded tool checks.

Impact: approval of a specific plan can become a blanket tool grant, especially around Bash.

Recommendation: convert approved `allowedPrompts` into explicit `canUseTool` checks. Treat plan approval as a scoped permission grant, not a global bypass.

### MAY-28 - P2 - Plan TTL is memory-only

Pending plan TTL is tracked in in-memory cleanup (`src/services/container-agent/sandbox-state.ts:33`). DB-recovered plan state can get a fresh runtime created-at rather than respecting the original expiration.

Impact: stale plans may remain approvable after restart.

Recommendation: persist `planExpiresAt` or compute expiry from DB timestamps. Reject stale recovered plans and surface expiry in the approval UI.

### MAY-29 - P2 - Host orphan sweep repairs agent state but not task state

The host-mode orphan sweep is present, but review evidence indicates it updates agent records without consistently repairing linked task state.

Impact: host-mode tasks can also remain misleadingly `in_progress` after process loss.

Recommendation: wrap sweep body with robust error handling, add last-run metrics, and update linked tasks out of `in_progress` when the sweep marks an agent orphaned.

### Resolved or materially improved

- Default sandbox image is digest-pinned in `SANDBOX_DEFAULTS`.
- Settings validation rejects tag-only `sandbox.defaults.image` overrides.
- Current Docker/K8s/Nomad credential injection uses file writes rather than env/argv paths.
- Tool whitelist default-open behavior is fixed.
- Provider recovery exists, though ownership semantics are still incomplete.
