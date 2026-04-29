# Sandbox Tenant Isolation

## Overview

This document describes the **multi-tenant deployment gate** that prevents accidental shared-sandbox-mode usage in deployments that host workloads for more than one tenant. The gate is the fail-safe ahead of the full multi-tenant FS/UID isolation rebuild, which is tracked as a follow-up.

**Reference**: `specs/arch_review_april29/06-security.md` finding **F06-NEW-02 (P0)** — Shared sandbox tenant isolation: still single-credential, still single-FS namespace.

---

## The threat

The default sandbox mode is **`shared`**. In this mode every codespace shares one Docker container. Inside that container:

| Resource | Isolation |
|---|---|
| Anthropic OAuth credentials file (`~/.claude/.credentials.json`) | **None** — single global file |
| `/workspace` bind mount | **None** — same host path mounted into the same container path |
| Per-tenant uid mapping | **None** — every tenant agent runs as the same `node` (uid 1000) user |
| seccomp / namespace partitioning | **None** beyond the container boundary itself |

Any user who can move a task into `in_progress` controls an agent that runs in the same container as every other tenant's agent. A hostile agent can read `/home/node/.claude/.credentials.json` and exfiltrate the global Anthropic token to a remote endpoint, or read source files mounted from another tenant's repository.

Per the April-29 arch review:

> "A `member`-role user who can move a task into `in_progress` controls an agent that runs in the same container as every other tenant's agent. A hostile agent can read `/home/node/.claude/.credentials.json` and exfiltrate the global Anthropic token to a remote endpoint."

---

## The gate (this PR)

This PR ships an **environment-variable gate** so that shared sandbox mode is no longer the silent default in any deployment that intends multi-tenancy.

### Behaviour

| `MULTI_TENANT` | `sandbox.mode` | Outcome |
|---|---|---|
| unset / `false` / anything-other-than-`true` | `shared` | **Allowed** — no behaviour change for self-hosted single-team installs (default). |
| unset / `false` / anything-other-than-`true` | `per-project` | **Allowed** — no behaviour change. |
| `true` | `shared` | **REJECTED** at the chokepoint with `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX` (HTTP 500). |
| `true` | `per-project` | **Allowed**. |

### Defaults

- **`MULTI_TENANT` defaults to `false`.** Self-hosted, single-team installs are unaffected and need not change anything.
- **`sandbox.mode` defaults to `'shared'`** to match the long-standing UI default at `src/app/routes/settings/sandbox/-sandbox-page.tsx:257`.
- The gate's resolver treats missing / malformed `sandbox.mode` settings as `'shared'` — the **safer default** is to refuse, not silently allow.

### Chokepoints

The gate is enforced at **both** chokepoints so it cannot be bypassed by adding a new caller that skips one of them:

1. **`src/services/container-agent/container-exec.service.ts:startAgent`** — reads `sandbox.mode` and throws before any sandbox lookup or auto-creation.
2. **`src/lib/sandbox/credentials-injector.ts:CredentialsInjector.inject`** — when an `InjectionContext` (containing `db`) is provided, runs the same check before writing the credentials file. The `sandbox.service.ts:create` call site passes the context so newly-provisioned sandboxes are gated.

The shared helper lives at `src/services/container-agent/shared-helpers.ts:assertSharedSandboxAllowed` to ensure both call sites share the same logic and error code.

### The error

Code: `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX` (HTTP 500). Defined in `src/lib/errors/sandbox-errors.ts`.

```text
MULTI_TENANT=true is set but sandbox mode is "shared". Shared sandbox mode is
forbidden in multi-tenant deployments because all tenant agents would share
a single Anthropic OAuth credentials file. Configure per-codespace sandboxes
(sandbox.mode = "per-project") or unset MULTI_TENANT.
```

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MULTI_TENANT` | `false` | Set to exactly `true` to enable the gate. Any other value (including unset, `false`, `0`, `1`, `yes`, `True`) keeps the gate disabled. |

The gate helper `isMultiTenantEnabled()` in `src/server/bootstrap/server-config.ts` is the single source of truth — it mirrors the `isDevAuthAllowed()` pattern in `src/lib/api/dev-auth.ts`.

### Operator workflow for hosted multi-tenant deployments

1. Set `MULTI_TENANT=true` in the deployment environment.
2. Configure `sandbox.mode = 'per-project'` in **Settings → Defaults → Sandbox Mode**.
3. Restart the server. The boot log will emit:
   ```text
   MULTI_TENANT=true is set - shared sandbox mode is FORBIDDEN. The container-exec service and credentials injector will refuse to operate when the resolved sandbox mode is "shared". Configure per-codespace sandboxes for every codespace before starting agents.
   ```
4. Any subsequent agent start with `sandbox.mode = 'shared'` returns a 500 error with code `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX` instead of silently leaking credentials.

---

## What this PR does NOT do (out of scope)

The full multi-tenant FS/UID isolation rebuild remains an **L-effort follow-up**. The remaining work is documented in `specs/arch_review_april29/06-security.md` under F06-NEW-02 and includes:

1. **Per-codespace credentials file** written via `putArchive` to a codespace-scoped uid (the `agent-sandbox` Docker image already supports `User: '1000:1000'`, but the host bind mount still needs per-codespace chown).
2. **Per-codespace `/workspace` bind mount** instead of the single shared mount.
3. **Stop emitting `CLAUDE_OAUTH_TOKEN` as a container env var** (currently still passed to `execStream` at `container-exec.service.ts:798`) — file-only.
4. **Boot-time self-check** in `bootstrap/phases/schema.ts` that fails-fast when more than one team exists in the DB and `MULTI_TENANT` is unset.
5. **K8s NetworkPolicy / Nomad `network_mode = "none"`** parity with the Docker default.

The gate in this PR is the operational fail-safe so the items above can land safely without leaving operators exposed in the meantime.

---

## Test coverage

Unit tests:
- `src/lib/sandbox/__tests__/credentials-injector.test.ts` — gate fires on inject + refresh; per-project mode allowed; missing setting defaults to shared (gate fires); MULTI_TENANT-unset / explicit-false / non-`true` strings all pass through.
- `src/services/container-agent/__tests__/container-exec-multi-tenant-gate.test.ts` — `assertSharedSandboxAllowed` throws / does-not-throw across the matrix; `resolveSandboxMode` falls back to `shared` on missing / malformed / unrecognised values.

Integration:
- Existing tenant-isolation tests in `tests/functional/` continue to pass with `MULTI_TENANT=false` (default) — no behaviour change for self-hosted installs.

---

## Cross-references

- Plan: `specs/arch_review_april29/master-readme.md` (Wave 1 PR W1-E).
- Finding: `specs/arch_review_april29/06-security.md` F06-NEW-02 (P0) and prior F06-08 (April-20).
- Related (still TODO): F04-06, F04-07, F06-NEW-05 — full credential file + token-env-var rework, tracked under PR W2-I.
