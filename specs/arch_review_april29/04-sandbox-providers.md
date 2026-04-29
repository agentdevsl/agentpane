# 04 — Sandbox Providers (April 29 Review)

Theme: Docker / Kubernetes (Agent Sandbox CRD) / Nomad provider parity, image
supply chain, lifecycle, orphan cleanup, network isolation, tenant isolation,
credentials injection, resource limits, AgentCore remnants. Verified against
HEAD `25c1c4f0` (post-PR #176, post-PR #178, post-PR #179).

**Constraints**: no Redis / new infra, fix existing code, all `path:line` refs
verified at HEAD.

**Headline**: PR #176 / theme-04 closed roughly half of the prior April-20
findings. The four biggest holes that remain are (a) the K8s
`agentpane-sandbox-template.yaml` manifest and the `Dockerfile.agent-sandbox`
base image still pin `srlynch1/...:latest` so the supposed-fixed P0-01 only
fixed the TypeScript constant (F04-01); (b) the Settings PUT endpoint accepts
`sandbox.defaults.image` without running `validateImage`, so a tenant admin can
override the default image to a tag-only ref through the UI (F04-02); (c) the
hand-rolled SigV4 signer still ships even though `@aws-sdk/client-sts` is now a
real dependency, AgentCore still gets unconditionally instantiated as a service
sub-component (the bridge service is statically imported), and the dynamic
import of `@aws-sdk/client-sts` is now obsolete (F04-04 / F04-05); and (d) the
unique-by-codespace constraint on `sandbox_instances` is *too strict* — once a
sandbox is stopped, the next `create()` for the same codespace fails with a
SQLite UNIQUE error rather than re-using the row (F04-08).

A new finding worth flagging: **K8s bootstrap shells out to `kubectl
apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/...`**
(F04-12). Same supply-chain class as the Docker image issue and not on the
prior review's list.

---

## P0 — Security / data loss

### F04-01 The "P0-01 supply-chain fix" only patched `SANDBOX_DEFAULTS.image`; the live K8s template manifest, Dockerfile base image, and integration-test fixtures still consume `srlynch1/...:latest`

`src/lib/sandbox/types.ts:118-125` now defaults to a placeholder digest, and
`SandboxConfigService.validateImage()` (`src/services/sandbox-config.service.ts:168-176`)
rejects tag-only refs **on the `sandbox_configs` CRUD path**. That looks
complete in isolation. But the actual paths the cluster pulls from are not
validated:

- `k8s/manifests/agentpane-sandbox-template.yaml:29` ships
  `image: srlynch1/agent-sandbox:latest` as the `SandboxTemplate` spec. The K8s
  bootstrap `attemptCrdAutoInstall` (`src/server/bootstrap/sandbox/k8s-init.ts:367`)
  applies this manifest verbatim with `kubectl apply -f`. Any operator who
  ran auto-install gets a cluster pinned to the mutable tag, and the
  `AgentSandboxProvider.create()` call only overrides `spec.podTemplate.spec.containers[0].image`
  on the `Sandbox` CRD — the `SandboxTemplate` (used for warm pool and
  fallback) keeps the tag pinning.
- `docker/Dockerfile.agent-sandbox:23` still has `ARG BASE_IMAGE=srlynch1/terraform-ai-tools:latest`
  and `:103` labels the image with `srlynch1/terraform-ai-tools:latest`. The
  Dockerfile comment at lines 21-22 says "Tag-only default is kept here for
  developer builds where pinning is painful" — meaning the dev build is
  intentionally exposed to compromise of the `srlynch1/*` namespace. Layer 1
  (the `BASE_IMAGE`) is not under the sandbox-image digest pin even when the
  outer image is published.
- `tests/integration/docker-provider.test.ts:91,118,140,159,207,221,237,249,321`
  and `tests/integration/sandbox-reconciliation.test.ts:84,119,167,200,241`
  hard-code `'srlynch1/agent-sandbox:latest'`. CI tests therefore pull from
  Docker Hub mutable tags every run; a typo-squat or compromised account in
  the `srlynch1/*` namespace would land malware in the CI runners.
- `npm install -g @anthropic-ai/claude-code` (`docker/Dockerfile.agent-sandbox:41`)
  is unpinned. `npm install` inside `agent-runner` (line 53) also has no
  `--frozen-lockfile`, despite CLAUDE.md elsewhere requiring it. A compromised
  npm registry or the `@anthropic-ai/claude-code` package becomes a tenant-isolation
  bypass.

Direction:
1. Pin the `SandboxTemplate` manifest (`k8s/manifests/agentpane-sandbox-template.yaml:29`)
   to a digest. Either inline the digest, or template it via Helm/kustomize
   so the same digest used in `SANDBOX_DEFAULTS.image` flows through.
2. Pin `BASE_IMAGE` in `docker/Dockerfile.agent-sandbox`. Add a CI gate that
   fails the build on tag-only `FROM`.
3. Update integration test fixtures to use the pinned default image (or a
   test-local tag pointed at a digest); add a lint that grep-fails on
   `srlynch1/...:latest` in tests.
4. Pin `@anthropic-ai/claude-code` (`npm install -g @anthropic-ai/claude-code@<exact>`)
   and `npm install --ignore-scripts --frozen-lockfile` for the `agent-runner`
   layer.
5. Document the rotation/ownership policy for the placeholder GHCR namespace
   so the digest publish workflow has an owner.

### F04-02 Tenant admins can bypass `validateImage` by setting `sandbox.defaults.image` through `PUT /api/settings` — the endpoint accepts arbitrary JSON and the bootstrap path consumes it without re-validating

The Zod schema at `src/lib/sandbox/types.ts:168-187` (`projectSandboxConfigSchema`)
enforces `isDigestPinnedImage` — but it is only used for codespace-level config.
The global default is stored under the `sandbox.defaults` settings key, written
through `PUT /api/settings` (`src/server/routes/settings.ts:113-167`), and the
endpoint validates with a generic `z.record(z.string(), z.unknown())` schema
(line 55). No image validation runs on the way in.

On the way out, `loadSandboxDefaultsFromDb()` at
`src/server/bootstrap/sandbox/sandbox-helpers.ts:21-45` parses the stored JSON
verbatim and returns `image?: string` to `ensureDefaultSandbox()` (line 87)
which passes it straight to `provider.create({ image: defaults?.image ?? SANDBOX_DEFAULTS.image, ... })`.
At no point does `validateImage` or `isDigestPinnedImage` gate the value.

So the supply-chain fix is one-deep: an admin who sets
`sandbox.defaults.image = "evil/repo:latest"` via the UI gets that image
pulled on the next bootstrap and on every default-sandbox auto-create.

Direction: in the `PUT /api/settings` handler, when the key is `sandbox.defaults`,
parse with a Zod object that includes the `image` digest-pinned refinement
from `projectSandboxConfigSchema`. Reject before write. Mirror the same
validation in `loadSandboxDefaultsFromDb()` as defense-in-depth — drop the
field with a `log.error` if it ever loaded an invalid value (recovery path
for a DB that was populated before the validation lands).

---

## P1 — Silent failure / scaling wall

### F04-03 The K8s `indexOf('exec ')` env-injection bug from F04-P2-02 still ships — Nomad uses `lastIndexOf`, K8s uses `indexOf`, and the K8s path mishandles any `cwd` that contains the substring `exec `

`src/lib/sandbox/providers/agent-sandbox-instance.ts:154` does
`const execIdx = shBody.indexOf('exec ');` with the comment claiming env vars
are injected before the exec'd command. `src/lib/sandbox/providers/nomad-sandbox-instance.ts:182`
does `lastIndexOf('exec ')` (line 180-181 actually has the comment "to avoid
matching 'exec' in path names").

If a customer has a worktree path containing `exec ` (e.g.
`/workspace/.worktrees/feat-execute-some-thing`, or any path generated from a
task title that includes the word "execute" — `slugify` doesn't drop spaces
that turn into hyphens, but the literal substring `exec-` would match
`.indexOf('exec ')` only with a trailing space, so this is a near-miss; the
real failure mode is when `cwd` ends with a directory whose name happens to
have `exec ` in it via shell-escaping artifacts).

More importantly the *contract* is now inconsistent: a customer hitting this
bug will see env vars injected into the wrong place on K8s but not on Nomad.
P2-02 from April-20 was deferred without justification; the fix is trivial —
make K8s `lastIndexOf` like Nomad — and there's still a lurking failure mode.

The shared `shellEscape` helper is also still triplicated
(`docker-provider.ts:325-328`, `agent-sandbox-instance.ts:100-102`,
`nomad-sandbox-instance.ts:137-139`) — same finding as P2-02 but unchanged.

Direction: extract `shellEscape` and `buildExecShellCommand(cmd, args, cwd, env)`
to `src/lib/sandbox/utils/shell.ts`. Have all three instance classes call it.
Add a regression test with `cwd: '/opt/foo-exec-bar'` and an env var, asserting
the env appears immediately before the *trailing* `exec`, not the embedded one.

### F04-04 AgentCore is gated by `AGENTCORE_ENABLED` for the *provider factory* but the bridge service, AWS SigV4 signer, and SDK types are unconditionally in the module graph — the dynamic import that the gate relies on no longer protects anything important

`src/services/container-agent/container-agent.service.ts:42` does
`import { AgentCoreBridgeService } from './agentcore-bridge.service.js'` —
**static import** at the top of the file. The bridge service in turn does
`import { createAgentCoreBridge } from '../../lib/agents/agentcore-bridge.js'`
at `agentcore-bridge.service.ts:15` (also static). That bridge module
re-exports SSEEvent types from `../sandbox/providers/agentcore-sandbox-instance.js`
(`agentcore-bridge.ts:14`), which is `import type` only — but
`agentcore-bridge.service.ts:20-21` does `import type` for the same things, so
in practice no runtime code from `agentcore-sandbox-instance.ts` lands in the
graph.

So the gate works for `agentcore-sandbox-instance.ts` (which has the AWS
SigV4 signer at lines 47-156) and `agentcore-sandbox-provider.ts` (which has
the dynamic STS check at lines 251-258). It does **not** work for
`agentcore-bridge.service.ts` (561 LOC), `lib/agents/agentcore-bridge.ts`
(SSE→DurableStreams glue), or the test mocks. Net result: AgentCore is
half-deleted, the gate is half-effective, and `AgentCoreBridgeService` is
instantiated in `ContainerAgentService`'s constructor on every server boot
regardless of the flag (`container-agent.service.ts:132-139`). It does
nothing — `getAgentCoreProvider()` returns undefined when the flag is off and
the `if (this.isAgentCoreProvider())` checks short-circuit the start-agent
path — but it's still memory and a maintenance burden.

Worse, the dynamic-import comment at `container-agent.service.ts:22-26` says
"the AWS SDK is not added to the module graph when AgentCore is disabled" —
but `@aws-sdk/client-sts` is now declared as a real dependency in
`package.json:93` (`"@aws-sdk/client-sts": "^3.1032.0"`). The
dynamic-string-name dance at
`agentcore-sandbox-provider.ts:251-252` (`const stsModuleName = '@aws-sdk/client-sts'; await import(/* webpackIgnore: true */ stsModuleName)`)
exists *specifically* to avoid TypeScript resolving the import statically when
the package wasn't installed. Now that the package is installed, the
contortion is dead weight and *also* obscures the real cost: AgentCore is no
longer a "free if unused" feature.

Direction: pick one. Either (a) actually remove AgentCore — delete
`src/services/container-agent/agentcore-bridge.service.ts`,
`src/lib/agents/agentcore-bridge.ts`, the two `src/lib/sandbox/providers/agentcore-*.ts`
files, the tests, the `setAgentCoreProvider()` method, and the `AGENTCORE_ENABLED`
gate; drop `@aws-sdk/client-sts` from `package.json`. The bridge has zero
non-test callers when the gate is off. Or (b) commit to it — replace the
hand-rolled SigV4 with `@aws-sdk/client-bedrock-agentcore`, drop the dynamic
import, and bring AgentCore under the `SandboxProvider` interface. The right
move is (a); the codebase has been "deciding to remove AgentCore" for two
review cycles now.

### F04-05 The hand-rolled SigV4 signer in `agentcore-sandbox-instance.ts` is ~110 LOC of crypto code that's only reachable when `AGENTCORE_ENABLED=true`, but ships in the binary regardless

`src/lib/sandbox/providers/agentcore-sandbox-instance.ts:47-156` implements
`hmacSha256`, `sha256Hex`, `getSignatureKey`, and `signRequest` against
`crypto.subtle`. Comment at line 51 says "DEFERRED: Replace with `@aws-sdk/signature-v4`...
once the package is added to dependencies." — `@aws-sdk/client-sts` is now a
dependency (which transitively pulls in `@aws-sdk/signature-v4`), so the
prerequisite is met but the swap hasn't happened.

Hand-rolled AWS signing is a known-bad pattern: easy to get wrong on
double-encoded URIs, session tokens, header ordering, payload-hash escapes,
and clock skew. AgentCore is in production for any tenant who turned the flag
on; if a regression in the signer causes silent 403s, the failure mode is
"AgentCore stops working" rather than a clear error. The maintenance
liability outlives any short-term gain.

Direction: if F04-04(b) — replace the signer with `@aws-sdk/client-bedrock-agentcore`'s
`InvokeAgentRuntimeCommand`. If F04-04(a) — delete the file.

### F04-06 Credentials injection landed `writeFile` on Docker only; K8s and Nomad still use the legacy `sh -c 'echo "<base64>" | base64 -d > path'` exec path that puts the base64-encoded credential in argv

`src/lib/sandbox/credentials-injector.ts:80-120` checks for
`typeof sandbox.writeFile === 'function'` and prefers the out-of-band path. But
only `DockerSandbox.writeFile` exists (`docker-provider.ts:339-357`,
implemented via `putArchive`). `AgentSandboxInstance` and
`NomadSandboxInstance` don't implement `writeFile`, so they fall to the legacy
`sh -c` branch (`credentials-injector.ts:91-119`) which embeds the base64 blob
in argv.

`ps -ef`, `/proc/*/cmdline`, and any container audit log will see the encoded
token. Base64-decoding gets the attacker the OAuth token. The shell user
inside the sandbox is `node` (UID 1000), and the agent-runner runs as that
user — anything the model decides to `Bash` during the credential-injection
window can exfiltrate.

The April-20 resolution acknowledged this as a follow-up but the K8s and Nomad
implementations have not landed at HEAD `25c1c4f0`. The container side has the
tar-build pattern as a reference; K8s uses the SDK's pod-cp equivalent; Nomad
needs either a sidecar/init pattern or an HTTP endpoint inside the container.
Until those land, the prior P1-05 finding remains live for two of three
providers, plus AgentCore (which has a different injection path entirely).

Bonus problem: even on Docker, `buildSingleFileTar` at
`docker-provider.ts:43-44` hard-codes `uid=1000, gid=1000`. If the image ever
runs the credential consumer as a different user (root for some health
checks, or a UID change in a future image version), the credential file will
be unreadable and the agent-runner will fall back to the env-var path
(`CLAUDE_OAUTH_TOKEN`) which leaks via `/proc/1/environ`. The UID should be
discovered from the image, not assumed.

Direction: implement `AgentSandboxInstance.writeFile()` using the SDK's
`copyToPod` or stream-based API; implement `NomadSandboxInstance.writeFile()`
via the Nomad SDK's `client.fs.put` (or a workaround using the `nomad alloc fs`
HTTP endpoint). Make `writeFile` a *required* method on the `Sandbox`
interface — same pattern as `recover()` was promoted in PR #176. Once all
three providers implement it, drop the `sh -c` fallback in
`CredentialsInjector` entirely. Replace the hard-coded UID/GID in
`buildSingleFileTar` with values discovered at sandbox creation (e.g. from
`docker inspect` `Config.User`).

### F04-07 `CLAUDE_OAUTH_TOKEN` is still passed via the container environment, so the credential file approach has not actually removed the env-var leak vector

`src/services/container-agent/container-exec.service.ts:148-149` builds the
env map with `CLAUDE_OAUTH_TOKEN: '[REDACTED]'`, and `:797-798` re-binds it to
the real `oauthToken` before passing to `execStream`. The real value is set
on the agent-runner process's environment.

Inside the container that means `/proc/<runner-pid>/environ` contains the
token (readable by the same UID — but a malicious model can `cat
/proc/self/environ` regardless of FS permissions). It also means `printenv`
in any user's shell history shows it, and any tool that captures the env for
debugging (e.g. crash dumps, `pmap`) leaks it.

The April-20 plan was: write to credentials file, drop the env var. The file
write is partial (Docker only — F04-06). The env-var drop has not happened.

Direction: stop passing `CLAUDE_OAUTH_TOKEN` to the agent-runner. Have the
agent-runner read `~/.claude/.credentials.json` exclusively (already its
primary path per CLAUDE.md). Audit any other places that fall through to env
vars (the `AGENT_*` env vars are fine — they're not secrets). Track this as a
single follow-up alongside F04-06.

### F04-08 `sandbox_instances.codespace_id UNIQUE` blocks the natural "stop sandbox, start new one" lifecycle — `SandboxService.create()` will throw a SQLite UNIQUE error on every recreate after a clean stop

`src/db/schema/sqlite/sandboxes.ts:18-21` declares
`codespaceId.notNull().unique()`. The April-20 resolution noted this is "stricter
than the asked-for partial-unique" — and it is, but stricter in the wrong
direction.

`SandboxService.create()` (`src/services/sandbox.service.ts:132-221`) does
`await this.db.insert(sandboxInstances).values(dbSandbox)` at line 193 with no
`onConflict` clause. After a sandbox stops (status moves to `stopped`,
`stoppedAt` populated, the row stays around), the next `create()` for the
same codespace will fail with `UNIQUE constraint failed: sandbox_instances.codespace_id`.
The provider already created the new container; the DB insert fails *after*
that work — leaving an orphan container with no DB row. A subsequent attempt
to look up the sandbox by codespace will find the *old* stopped row.

The intended dedup semantic is "no two `running`/`creating` sandboxes for the
same codespace". The schema enforces "at most one row, ever". These differ,
and the difference is observable.

Direction: replace the unique constraint with a *partial* unique index on
`codespaceId` where `status IN ('creating', 'running', 'idle', 'stopping')`.
Drizzle/SQLite supports this via `where()` on the index. Update the insert in
`SandboxService.create()` to either (a) delete the prior `stopped` row before
insert, or (b) use `onConflictDoUpdate` to overwrite the row's
status/containerId/image. Add a test that runs `create → stop → create` for
the same codespace and asserts both creates succeed.

### F04-09 The default Docker network mode is still `bridge` and `SANDBOX_DEFAULT_NETWORK_MODE=none` is silently ineffective on K8s and Nomad — the warning log is the only enforcement

PR #176 added `getDefaultSandboxNetworkMode()`
(`src/lib/sandbox/types.ts:99-102`) and wired it into `DockerProvider.create()`
(`docker-provider.ts:657`). For Docker the env var works.

For K8s, `agent-sandbox-provider.ts:108-118` only logs a warning if the env
var is set to `none` — `SandboxBuilder` is invoked with no `NetworkPolicy`
spec regardless. For Nomad, `nomad-sandbox-provider.ts:117-125` does the same:
warn-and-continue, no `network` stanza added. So an operator who sets
`SANDBOX_DEFAULT_NETWORK_MODE=none` to harden a multi-tenant K8s/Nomad
cluster gets the same exposed-network behaviour as before, with only a log
line to indicate the mismatch between intent and reality.

The setting field `networkPolicyEnabled` is stored on `sandbox_configs`
(`src/db/schema/sqlite/sandbox-configs.ts:30`,
`src/services/sandbox-config.service.ts:301`), and the API exposes it
(`src/server/routes/sandbox.ts:34`,
`src/server/routes/sandbox-configs.ts:29`), but no provider reads it. The flag
is a dummy.

Direction: emit a default-deny `NetworkPolicy` from `AgentSandboxProvider.create()`
when `networkPolicyEnabled` (or the env var) is set. The CRD spec already has
labels like `agentpane.io/sandbox-id` (`agent-sandbox-provider.ts:174`), so a
NetworkPolicy with `podSelector: matchLabels: agentpane.io/sandbox-id: <id>`
selecting only that pod is straightforward. For Nomad: emit a `network { mode
= "none" }` block, or use Consul Connect with allowlisted upstreams. Add a
test that creates a sandbox with `networkPolicyEnabled: true` and asserts the
NetworkPolicy / network stanza is generated.

### F04-10 Per-tenant quota enforcement was added as a *function* (`SandboxConfigService.assertQuota`) but no caller invokes it — `SandboxService.create()` and `provider.create()` both skip it

`src/services/sandbox-config.service.ts:186-207` exposes `assertQuota()` as a
public method, takes a `SandboxQuota` and `QuotaCheckArgs`, returns
`Result<void, SandboxConfigError>` with a `SANDBOX_QUOTA_EXCEEDED` error.
`tests/lib/sandbox/sandbox-theme-04.test.ts:321-368` exercises the function
in isolation.

But `grep -r "assertQuota"` returns only the definition + tests. No call
site. `SandboxService.create()` (`src/services/sandbox.service.ts:132-221`)
does *no* quota check — it goes straight from "image available" to
`provider.create()`. A tenant with admin access can request 16 cores / 32 GB
per sandbox (the schema's max) and spawn unlimited concurrent sandboxes. The
April-20 resolution flagged this as "follow-up to wire tenant identity
through" — at HEAD `25c1c4f0` the wiring still hasn't landed.

Disk-usage metrics are also still hard-coded to `diskUsageMb: 0` on all three
providers (`docker-provider.ts:306`, `agent-sandbox-instance.ts:331,345`,
`nomad-sandbox-instance.ts:415`). The UI's sandbox metrics panel shows "0 MB"
disk usage which is materially wrong.

Direction: thread tenant identity through `SandboxService.create()` (look up
the codespace's team/owner, fetch the quota from settings or a per-team
config). Call `assertQuota()` before `provider.create()`. Add a test that
asserts the create returns `SANDBOX_QUOTA_EXCEEDED` when the tenant is at
limit. Separately, wire disk usage at least for K8s (`metrics-server`) and
Docker (`docker stats` exposes block-IO; `du -sh /workspace` for slower
periodic capture). Mark the field nullable in the type and render
"unavailable" on the UI when missing rather than "0 MB".

### F04-11 K8s bootstrap shells out to `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml` — second-class supply-chain hole no different from F04-01

`src/server/bootstrap/sandbox/k8s-init.ts:354-358` does:

```typescript
await execAsync(
  'kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml"',
  { timeout: 60_000 }
);
```

`releases/latest/download/...` is a moving pointer. A compromise of the
`kubernetes-sigs/agent-sandbox` repo (or its release process) lands the
malicious controller in every cluster that ever ran auto-install. The
controller has cluster-scoped permissions (it manages `Sandbox` CRDs and the
pods they reference), so this is full cluster takeover — strictly worse than
the F04-01 sandbox-image case.

Same class hole exists in `heal-intervals.ts:117` (also applies manifests
from disk via `kubectl apply -f`). The on-disk manifests at least live in the
repo and are subject to PR review; the URL fetch is not.

`waitForCrdRegistration` at `k8s-init.ts:55-71` also runs `kubectl get crd
sandboxes.agents.x-k8s.io` via shell-exec — that's a read-only call but it
relies on the host's `kubectl` being trustworthy and on `PATH`. If the
operator ever runs the AgentPane server in a container without `kubectl`
installed, the bootstrap silently fails (no fallback to the in-process SDK
client).

Direction: pin the install-manifest URL to a specific release tag and embed
the SHA-256 in code; before `kubectl apply`, fetch the URL, hash it, compare,
fail closed on mismatch. Or vendor the manifest into the repo and apply from
disk only. Replace the `kubectl exec` shell-out in `waitForCrdRegistration`
with a direct `client.healthCheck()` call (it already returns
`crdRegistered`). Replace the `kubectl apply -f` calls in
`attemptCrdAutoInstall` and `heal-intervals.ts` with the SDK's apply-from-YAML
helper if available, or document that auto-install requires `kubectl` on the
PATH and fail fast otherwise.

### F04-12 GitHub token still flows through argv in K8s workspace initialization — same pattern as F04-06 but for git tokens, not OAuth

`src/lib/sandbox/k8s-workspace-initializer.ts:89` builds
`const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;`
and then passes it as the last argv to `git remote add origin <url>` at
`:122-128` (and `set-url origin <url>` at `:132-138`, `:144-151`). The token
appears in argv on every `git remote` call inside the pod.

Mitigations exist: line 50's `sanitizeCredentials` strips the token from
*log output*, and the URL is replaced with the credential-less version after
clone (line 91 comment "We strip it from the remote immediately after clone")
— except I don't see the strip step in the current file (the comment is
aspirational; `git remote set-url origin <stripped>` doesn't appear in the
visible code). So the token sits in `git remote -v` output for the lifetime
of the worktree.

This is the same threat surface as F04-06 (P1-05): the agent-runner is a
`Bash`-capable model running inside the same pod. A prompt injection that
makes the model emit `git remote -v` or `cat .git/config` recovers the
token. The token then unlocks repository access for all of the org's repos
the GitHub App was installed in.

Direction: use git's `credential.helper` mechanism to inject the token via
stdin (or via `GIT_ASKPASS` script), not in the URL. Or use `GIT_CONFIG_COUNT`
+ `GIT_CONFIG_KEY_0` env vars (which still leak via `/proc/*/environ`, so the
helper-script approach is preferred). After clone, `git remote set-url origin
https://github.com/${owner}/${repo}.git` to remove the token from the remote
config entirely. Same regression test: `git remote -v` should show no token.

---

## P2 — Maintainability / consistency / type-safety

### F04-13 Three different `execAsRoot` semantics — Docker actually runs as root, K8s logs warn + falls back to non-root, Nomad throws — and zero non-test callers exist anywhere in the codebase

The contract is `Sandbox.execAsRoot(cmd, args?)` (`sandbox-provider.ts:66`).
Implementations:

- `DockerSandbox.execAsRoot()` — actually runs as `root`
  (`docker-provider.ts:107-109`, `:117-118` sets `User: 'root'`).
- `AgentSandboxInstance.execAsRoot()` — logs a warning and silently calls
  `this.exec()` (`agent-sandbox-instance.ts:72-78`).
- `NomadSandboxInstance.execAsRoot()` — throws unconditionally
  (`nomad-sandbox-instance.ts:111-116`).

Calling code cannot rely on the contract. Worse, `grep -rn execAsRoot
src/services/ src/server/ --include='*.ts'` returns zero non-test hits. The
method has no production callers at HEAD. It is effectively dead code,
maintained in three different ways across three providers, with no tests
asserting parity.

The interface, the implementations, and the silent fallback in K8s are all
contributing to a contract that lies. Either remove the method, or make it
do the same thing everywhere.

Direction: remove `execAsRoot` from `Sandbox` interface. Delete the three
implementations. If a future feature needs root exec, add it back through a
typed capability: `interface RootCapableSandbox extends Sandbox { execAsRoot(...)
}` and have the service layer check `'execAsRoot' in sandbox` before calling.

### F04-14 Provider events `sandbox:idle`, `sandbox:stopping`, `sandbox:stopped` are declared in the type union but never emitted by any provider — the union is a lie

`src/lib/sandbox/providers/sandbox-provider.ts:218-226` defines eight event
variants. Provider emit calls (verified via grep across all three providers):

- `sandbox:creating` — Docker, K8s, Nomad ✓
- `sandbox:created` — Docker, K8s, Nomad ✓
- `sandbox:starting` — none
- `sandbox:started` — Docker, K8s, Nomad ✓
- `sandbox:idle` — none (only published via durable streams in
  `sandbox.service.ts:470`)
- `sandbox:stopping` — none (only durable stream at `sandbox.service.ts:269`)
- `sandbox:stopped` — none (only durable stream at `sandbox.service.ts:300`)
- `sandbox:error` — Docker, K8s, Nomad ✓

A consumer subscribing via `provider.on(listener)` to track idle/stopping/stopped
gets nothing. The events flow only through `DurableStreamsService.publish()`
calls in `SandboxService` — which means in-process listeners (e.g. metrics,
audit logging) need to subscribe to the durable stream, not the provider bus.
That's confusing and means provider-bus listeners silently miss half the
lifecycle.

Same finding as April-20 P2-03; unchanged.

Direction: route all provider lifecycle events through the bus. Have
`SandboxService.stop()` call `provider.emit({ type: 'sandbox:stopping', ... })`
before the provider's own `stop()` and emit `sandbox:stopped` after. Or
narrow the type union to the four events that actually fire and rename the
type to `SandboxProviderLifecycleEvent`. Either way, eliminate the lie.

### F04-15 `validateContainers/validateSandboxes` silently evict from the in-memory cache without DB reconciliation — the database keeps showing `running` for sandboxes the provider has already forgotten

All three providers evict sandboxes from their in-memory map when an inspect
call returns 404 or errors:

- Docker: `validateContainers` at `docker-provider.ts:751-782` — deletes from
  `sandboxes` map and `codespaceToSandbox`, no DB update, no event.
- K8s: `validateSandboxes` at `agent-sandbox-provider.ts:311-335` — same
  pattern.
- Nomad: `validateSandboxes` at `nomad-sandbox-provider.ts:356-383` — same.

Downstream effects: `SandboxService.getById()` queries the DB, finds the row
with `status: 'running'`, returns it; the API returns "running" to the UI;
the UI shows a sandbox that doesn't exist. The idle-checker
(`sandbox.service.ts:455-484`) reads from the DB and tries to `stop()` the
already-evicted sandbox — `provider.getById()` returns null,
`SandboxErrors.CONTAINER_NOT_FOUND` is thrown, idle check fails, failure
counter increments. After 5 failures the idle checker disables itself
(`sandbox.service.ts:73-75`). End result: ghost sandboxes in the DB and a
disabled idle checker.

Same finding as April-20 P2-05; unchanged.

Direction: when a provider evicts from its in-memory cache, it must (a) emit
`sandbox:error` or `sandbox:stopped` via the provider bus, and (b) the
service layer must subscribe and update the DB row. Or do the DB update from
the provider directly (couples provider to DB but is simpler). Add an
integration test that creates a sandbox, deletes the underlying container
out-of-band, calls `list()`, and asserts the DB row transitions to
`stopped`/`error` and a stream event fires.

### F04-16 Three near-identical tmux implementations — DockerSandbox, AgentSandboxInstance, NomadSandboxInstance — none of them use the `TmuxManager` that already exists at the service layer

`src/lib/sandbox/providers/docker-provider.ts:177-274` implements
createTmuxSession/listTmuxSessions/killTmuxSession/sendKeysToTmux/captureTmuxPane.
`agent-sandbox-instance.ts:210-313` and `nomad-sandbox-instance.ts:268-397`
copy-paste the same five methods with different error types and minor variations
(e.g. Nomad has `assertRunning()` guards, K8s doesn't).

Meanwhile `src/lib/sandbox/tmux-manager.ts` already exists at the service
layer and is used by `SandboxService` (`sandbox.service.ts:50`). It wraps
sandbox.exec() and provides the same five methods.

The three instance-level tmux methods are unused (the service-level
TmuxManager wraps them but the instance methods are not called directly). The
TmuxManager itself routes through `sandbox.exec()` so any tmux change made at
the manager level "just works" for all three providers.

April-20 P2-01 (and code comment SC-037 at `docker-provider.ts:174-176`)
flagged this. Unchanged at HEAD.

Direction: delete `createTmuxSession`/`listTmuxSessions`/`killTmuxSession`/`sendKeysToTmux`/`captureTmuxPane`
from the `Sandbox` interface and all three implementations. Have callers go
through `TmuxManager` exclusively. Retire SC-037.

### F04-17 8-character sandbox-ID slicing in DNS-1123 names creates collision risk that no provider checks for

`docker-provider.ts:645`, `agent-sandbox-provider.ts:154`,
`nomad-sandbox-provider.ts:158` all build resource names as
`agentpane-${codespaceId.slice(0, 20)}-${sandboxId.slice(0, 8)}`. cuid2 IDs
have a 36-char alphabet so 8 chars is `36^8 ≈ 2.8e12` — but that's the
*global* space, not the per-codespace space. For a single codespace, only
the last 8 chars of the sandbox ID vary (the codespace-prefix is fixed), so
two consecutive `create()` calls inside the per-process mutex window could
race-collide if a codespace runs many sandboxes.

In practice the in-memory mutex (`creatingCodespaces` set) prevents this for
serial creates, and the DB unique constraint on `codespace_id` (F04-08)
prevents it for parallel creates within a single API server. But the moment
you add a second API server replica or scale horizontally, neither guard
holds — the collision check is `Map.has()`, not a cluster-wide lookup.

Same finding as April-20 P2-04; unchanged.

Direction: increase to 12-16 chars of the sandbox ID. Or use the full ID and
hash the codespace prefix to fit DNS-1123's 63-char limit (e.g. `agentpane-`
+ 8-char hash of codespaceId + `-` + 12-char sandbox ID prefix). Add a
uniqueness check on the generated name before `createSandbox`/`registerJob`
— if it exists, regenerate.

### F04-18 `pullImage`/`isImageAvailable` are no-ops on K8s and Nomad — typo'd image refs fail late with `POD_CREATION_FAILED` instead of an actionable error

`agent-sandbox-provider.ts:448-459`: `pullImage` just non-empty-checks the
string and returns; `isImageAvailable` returns `image !== undefined && image.trim() !== ''`.
`nomad-sandbox-provider.ts:530-541`: same.

If a tenant configures `image: 'nonexistnt/typo:tag'`, `SandboxService.create()`
calls `provider.isImageAvailable()` (returns `true`), then
`provider.create()` which calls `client.createSandbox()` (succeeds — the
manifest is just YAML), then `client.waitForReady()` which times out at 120s
because the pod is stuck in `ImagePullBackOff`. The user sees
`POD_CREATION_FAILED: 120s timeout`. They have no idea the root cause is a
typo.

Same finding as April-20 P2-08; unchanged.

Direction: in `AgentSandboxProvider`, make `isImageAvailable()` actually
probe — create a short-lived `ImagePullJob` Pod (a no-op container that just
needs the image), wait for ready or fail with the actual K8s event reason
(`ImagePullBackOff`, `ErrImagePull`, `InvalidImageName`). For Nomad: hit the
configured Docker registry's `HEAD /v2/<repo>/manifests/<digest>` with
registry credentials. At minimum, when `waitForReady` times out, scrape the
pod's events and surface `ImagePullBackOff` distinctly from a generic
timeout.

---

## P3 — Polish / docs

### F04-19 K8s `LimitRange` is applied via auto-install but the `ResourceQuota` (the namespace-level enforcement) is commented out

`k8s/manifests/limit-range.yaml:9-46` defines a per-container LimitRange — it
sets defaults and minimums but doesn't enforce a ceiling on aggregate
namespace usage. The `ResourceQuota` at lines 49-77 is commented out with
"uncomment to enforce". That comment is the polite way of saying "not
enforced".

A misconfigured codespace can still exceed the per-pod max (the LimitRange
caps at 32Gi/16cpu — same as the Zod schema in `types.ts:158`), but nothing
prevents 100 sandboxes × 32Gi = 3.2 TB of memory across the namespace.

Direction: ship the ResourceQuota with conservative defaults (e.g. 50 pods,
256 GiB memory, 64 CPUs total). Make the values configurable via Helm/kustomize.
Document the relationship between `SandboxConfigService.assertQuota()`
(F04-10, application-level) and `ResourceQuota` (cluster-level) — they should
agree.

### F04-20 `runtimeClassName: 'gvisor' | 'kata' | 'none'` is exposed in K8s provider options and used in the default template (`agentpane-sandbox-template.yaml:20` sets `runtimeClassName: gvisor`) but no docs cover when to use which, the trade-offs, or how to verify gVisor is actually running

The `SandboxBuilder` exposes `runtimeClass()` and the K8s provider passes
through whatever the operator set. The runtime-class manifest at
`k8s/manifests/runtime-class-gvisor.yaml` registers gVisor — but if the
cluster doesn't have `runsc` installed, pods will silently fall back to the
default `runc` runtime *or* fail to schedule (depends on the cluster
controller). No health-check surfaces this.

Direction: add a doc page `specs/sandbox/architecture/isolation-layers.md`
covering: (a) what each runtime class provides, (b) what's installed by the
default templates, (c) how to verify gVisor is actually running
(`kubectl get pod -o yaml | grep runtimeClassName`), (d) the performance and
syscall-compatibility trade-offs. In the K8s health check, surface whether
the configured `runtimeClassName` is actually available in the cluster.

### F04-21 The K8s provider swallows `list()` errors and returns `[]` while Nomad re-throws — UI sees "no sandboxes" under K8s and an error under Nomad, even when the underlying failure mode is the same

`agent-sandbox-provider.ts:440-445`: `catch (error) { log.error(...); return [] }`.
`nomad-sandbox-provider.ts:521-527`: `catch (error) { log.error(...); throw
error }`. `docker-provider.ts:724-745`: `validateContainers()` first then
returns the (post-validation) cache, never throws.

Same operational issue as before: a transient cluster failure looks like
"empty list" on K8s, "error" on Nomad, and "stale list" on Docker. The
`SandboxProvider` interface comment at `sandbox-provider.ts:175-180` ("Callers
should treat a thrown `list()` as 'unknown', not 'none'") acknowledges the
asymmetry but doesn't fix it.

Direction: pick one. Recommendation: throw a typed `ProviderError` with
`code: 'LIST_TRANSIENT'` so callers can distinguish "no sandboxes" from
"can't tell". Update the UI's empty-state to render "Cluster unreachable"
when it sees the typed error.

---

## Summary

- **Findings**: 21 total
- **P0**: 2 — supply chain regressions (image manifest still tag-pinned,
  settings PUT bypass)
- **P1**: 10 — K8s env-injection still using `indexOf`, AgentCore half-removed,
  hand-rolled SigV4, K8s/Nomad credential injection still via argv,
  `CLAUDE_OAUTH_TOKEN` env var, sandbox-instance UNIQUE blocks recreate, K8s
  network policy not generated, per-tenant quota wired but not called,
  `kubectl apply` of mutable URL, GitHub token in argv
- **P2**: 6 — `execAsRoot` lies, provider events lie, silent cache eviction,
  triplicated tmux, 8-char ID truncation, `pullImage` no-ops on K8s/Nomad
- **P3**: 3 — ResourceQuota commented out, runtimeClass undocumented, `list()`
  semantics diverge

**Priorities for next remediation cycle**:

1. F04-01 + F04-02 + F04-11 — close the supply-chain holes properly (K8s
   manifest digest, PUT settings validation, kubectl apply URL pinning).
   These are P0/P1 and ship as one PR with grep-based CI gates.
2. F04-04 + F04-05 — actually delete AgentCore. Two review cycles of
   "deferred" is enough; the option-(b) path requires a real product
   commitment and there's no signal of that.
3. F04-06 + F04-07 — ship `writeFile` for K8s/Nomad and remove the env-var
   fallback. This is the credential-leak issue and it's been one PR cycle
   already.
4. F04-08 — fix the unique constraint. Smallest change, biggest user-facing
   impact (every recreate currently fails).
5. F04-10 — wire `assertQuota` into `SandboxService.create()`. The function
   already exists; just call it.

After this cycle the remaining findings are mostly developer-quality issues
(tmux dedup, dead `execAsRoot`, shellEscape extraction, event-bus alignment)
that can be batched into a "sandbox cleanup" PR.

**Tests still in good shape**: `tests/lib/sandbox/sandbox-theme-04.test.ts`
covers digest-pinned image validation, recover() for K8s and Nomad, the
credential-injection writeFile path, the network-mode env opt-in, and
quota-rejection cases. New tests required for the items above:
- A test that PUT `/api/settings` rejects `sandbox.defaults.image` set to a
  tag-only ref (F04-02).
- A test that creates a sandbox with `cwd: '/opt/foo-exec-bar'` and an env
  var, asserts the env appears at the trailing exec (F04-03).
- An integration test for stop-then-create-same-codespace (F04-08).
- A test that asserts NetworkPolicy is emitted when `networkPolicyEnabled:
  true` (F04-09).
- A test that `SandboxService.create()` returns `SANDBOX_QUOTA_EXCEEDED` when
  `assertQuota` fails (F04-10).
