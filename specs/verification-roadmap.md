# AgentPane Verification & Code Quality Strategy

> Generated 2026-03-26 via concurrent OPUS agent analysis across 5 dimensions: industry research, testing infrastructure, code quality, security, and spec-implementation alignment.

## Executive Summary

This document defines **strategic verification frameworks** for AgentPane — an agent orchestration platform where autonomous AI agents execute code in sandboxed environments. The focus is on prevention systems, not individual fixes: how to structurally ensure code quality, catch regressions early, and maintain correctness as the platform scales.

Six verification frameworks are proposed, ranked by strategic impact. Each framework is a **persistent system** that continuously prevents classes of defects rather than fixing individual instances.

---

## Codebase Analysis Summary

Analysis was conducted by 5 concurrent OPUS agents examining: testing infrastructure (7,308 tests, 5 Vitest project types, CI sharding), code quality (strict TypeScript, Result types, Zod validation), security (sandbox isolation, RBAC, auth defense-in-depth), and spec alignment (4 state machines, 193 specified test cases, 42 wireframes).

**What's already strong:**
- Strict TypeScript (`noUncheckedIndexedAccess`, `Result<T,E>` pattern, only 127 `any` usages)
- Comprehensive Zod validation at API boundaries
- 256 structured error codes across 25 domain files
- Multi-agent code review (5 specialized reviewer types)
- Defense-in-depth auth (triple-gated dev bypass, SHA-256 token hashing, RBAC role ceiling)
- Agent safety primitives (plan-approve-execute, tool whitelist, turn limits, stop files)

**What's structurally missing:**
- No verification framework connecting specs to code (3 of 4 state machine specs have drifted)
- No property-based or model-based testing (state machines tested only with examples)
- No mutation testing (test assertion quality is unverified)
- No security-focused static analysis beyond Biome (no Semgrep/CodeQL)
- No runtime invariant monitoring framework
- E2E tests exist (260 cases) but don't run in CI
- Frontend component coverage at 13% with no framework for systematic improvement

---

## Strategic Framework 1: Specification-as-Contract Verification

**Priority: P3 (Low) | Strategic Impact: Moderate | Maturity: Foundational**

### Why This Matters Most

AgentPane has a rare asset: a comprehensive specification library (4 state machines, 9 service specs, 19 component specs, 42 wireframes, 193 test cases). Most codebases have no specs at all. But specifications only have value when they're **synchronized with implementation** — drifted specs are worse than no specs because they create false confidence.

Today, 3 of 4 state machine specs have drifted from implementation (agent lifecycle missing `planning` state in code, task workflow missing `queued` in machine, worktree has 10 states vs 6 in spec). The spec references XState throughout but the code uses custom pure-function machines. Service specs reference "project" while code uses "codespace."

### The Framework

**Automated spec-code consistency checking** — a CI pipeline that parses structured sections of specification documents and verifies claims against the actual codebase.

#### What It Verifies

| Spec Artifact | Verification Method |
|--------------|-------------------|
| State machine state lists | Parse spec state enums → compare to `types.ts` exports |
| State machine transitions | Parse spec transition tables → compare to machine event handlers |
| API endpoint inventory | Parse endpoints.md route list → compare to files in `src/server/routes/` |
| Error code catalog | Parse error-catalog.md codes → grep for `createError()` calls |
| Database table count | Parse schema.md → compare to `sqliteTable()` call count |
| README metric claims | Parse "N tables, M routes" → verify against actual counts |
| Service interface contracts | Parse service spec method signatures → compare to exported types |

#### How It Works

1. **Structured spec format** — Specs use parseable patterns (markdown tables, code blocks with type signatures, enumerated state lists) that a verification script can extract
2. **Verification script** (`scripts/verify-specs.ts`) — Runs in CI, reads spec files and source files, compares claims against reality
3. **CI gate** — Fails PRs that introduce drift (new states not in spec, spec claims not matching code)
4. **Bidirectional enforcement** — Forces developers to update specs when changing code AND update code when changing specs

#### What This Prevents

- State machine specs promising states that don't exist (or missing states that do)
- README claims drifting ("36 tables" when there are actually 41)
- New services/routes being added without spec coverage
- Architectural decisions documented in specs diverging from implementation

#### Maturity Path

1. **Phase 1:** Verify countable claims (state counts, route counts, table counts)
2. **Phase 2:** Verify structural claims (transition tables, error code mappings)
3. **Phase 3:** Executable specifications — specs that ARE tests (Cucumber/Gherkin or custom DSL for state machines)

---

## Strategic Framework 2: Property-Based & Model-Based Testing

**Priority: P0 | Strategic Impact: Very High | Maturity: Foundational**

### Why This Matters

AgentPane's 4 state machines (agent, task, session, worktree) govern the **entire system lifecycle**. They determine when agents start, what tasks can be approved, when sessions close, and how worktrees are cleaned up. An invalid state transition can leave the system unrecoverable.

Today, these machines are tested with 141 example-based test cases — specific input/output pairs. This catches known scenarios but **cannot find unknown edge cases**. Property-based testing generates thousands of random input sequences and verifies that invariants hold for ALL of them.

### The Framework

**Property-based testing with fast-check** — define mathematical properties that must hold for all inputs, then let the framework find counterexamples.

#### Property Types for State Machines

| Property | What It Proves | Example |
|----------|---------------|---------|
| **No undefined states** | Every event from every state produces a defined result | `fc.assert(fc.property(arbitraryState, arbitraryEvent, (s, e) => transition(s, e) !== undefined))` |
| **Idempotence** | Applying an event twice from the same state yields the same result | `transition(s, e) === transition(transition(s, e).state, e)` for idempotent events |
| **Reachability** | All states are reachable from the initial state via some event sequence | BFS over state graph |
| **Termination** | Error and completed states are absorbing (no events leave them) | `∀e: transition('completed', e).state === 'completed'` |
| **Guard consistency** | Guards never both accept and reject for the same context | No contradictory guard conditions |
| **Model agreement** | Random event sequences produce same results in machine and simplified model | Side-by-side execution |

#### Property Types for Services

| Property | What It Proves | Example |
|----------|---------------|---------|
| **Round-trip** | `deserialize(serialize(x)) === x` | JSON storage, API request/response |
| **Invariant preservation** | Business rules hold after any sequence of operations | "Task in `verified` always has a non-empty diffSummary" |
| **Commutativity** | Independent operations produce same result regardless of order | Concurrent agent starts on different tasks |
| **Monotonicity** | Certain values only increase (event sequence numbers, version counters) | Durable stream sequence IDs |

#### What This Prevents

- Edge cases in state machine transitions that example-based tests miss
- Race conditions in concurrent agent execution
- Data corruption through unexpected operation sequences
- Regressions when modifying state machine logic (properties are more robust than examples)

#### Maturity Path

1. **Phase 1:** Property tests for all 4 state machines (invariant, reachability, termination)
2. **Phase 2:** Model-based testing — simplified models of services vs real implementations
3. **Phase 3:** Stateful property testing — random sequences of API calls against running server

---

## Strategic Framework 3: Security Static Analysis Pipeline

**Priority: P1 | Strategic Impact: High | Maturity: Established Industry Practice**

### Why This Matters

AgentPane executes AI-generated code in sandboxed environments. The security boundary between agent code and the host system is the **most critical trust boundary** in the application. Biome catches style issues and basic correctness, but doesn't analyze security-specific patterns like command injection, path traversal, or capability leaks.

The codebase already has strong security patterns (shell escaping, Zod validation, symlink-aware path checking). The gap is **systematic enforcement** — ensuring these patterns are used consistently and that new code follows them.

### The Framework

**Semgrep with custom rules** — pattern-based static analysis that encodes AgentPane-specific security invariants as automated checks.

#### Rule Categories

| Category | What Rules Detect | Why It Matters for AgentPane |
|----------|------------------|----------------------------|
| **Shell safety** | Command construction without `shellEscape()` or array-based spawn | Agents execute shell commands; injection = host compromise |
| **Path safety** | File operations without traversal checks, missing `realpath()` | Agents manipulate files in `/workspace`; traversal = sandbox escape |
| **Deserialization safety** | `JSON.parse` without Zod validation, `as unknown as` casts | Stored data from agent output could be malformed |
| **Error handling** | Empty catch blocks, `catch(e) {}` patterns | Silent failures in agent lifecycle mask critical issues |
| **Container safety** | Docker API calls without `CapDrop`, unrestricted network mode | Agent sandboxes must enforce least privilege |
| **Auth patterns** | Auth bypass conditions, token handling without hashing | Platform security depends on consistent auth enforcement |
| **Secrets** | Hardcoded tokens, keys in code or config, unredacted error messages | API keys in logs or responses = credential leak |

#### How It Works

1. **Rule library** (`.semgrep/` directory) — YAML rules encoding patterns specific to this codebase
2. **CI integration** — Runs on every PR, blocks merges when security rules are violated
3. **Incremental scanning** — Only scans changed files for fast feedback
4. **Rule evolution** — When a security issue is found and fixed, add a Semgrep rule to prevent recurrence

#### What This Prevents

- New shell command code paths that bypass escaping
- New file operations without path validation
- Capability regression in container security configuration
- Patterns that were caught in review but could recur without a rule

#### Complementary Tools

| Tool | Purpose | When to Add |
|------|---------|-------------|
| **CodeQL** | Deep data-flow analysis (taint tracking) | When Semgrep rules need flow-sensitivity |
| **Socket.dev** | Supply chain attack detection for npm deps | When dependency surface grows |
| **Snyk Code** | AI-assisted vulnerability detection | When continuous scanning budget allows |

---

## Strategic Framework 4: Mutation Testing for Test Quality

**Priority: P1 | Strategic Impact: High | Maturity: Established**

### Why This Matters

Test coverage measures which lines execute during tests. But a test that executes code without verifying behavior provides false confidence. Mutation testing answers: **"Would my tests catch it if someone introduced a bug?"**

With 7,308 test cases and ~69% statement coverage, AgentPane has quantity. Mutation testing reveals whether those tests have quality — do they actually assert the right things?

### The Framework

**Stryker Mutator with incremental CI integration** — modifies source code (flips operators, removes statements, changes conditions) and checks if tests catch each mutation.

#### Mutation Operators Relevant to AgentPane

| Operator | What It Does | What Surviving Mutants Reveal |
|----------|-------------|------------------------------|
| **Conditional boundary** | `>=` → `>`, `<=` → `<` | Off-by-one errors not caught by tests |
| **Negate conditional** | `===` → `!==` | Guard conditions not properly verified |
| **Remove statement** | Delete a line of code | Dead code or missing assertion |
| **String mutation** | Change string literals | Hardcoded values not verified |
| **Boolean substitution** | `true` → `false` | Flag-dependent logic not tested |
| **Return value** | Change return values | Return value not checked by caller tests |

#### Focus Areas (Highest ROI)

| Area | Why | Expected Mutation Score |
|------|-----|----------------------|
| State machine guards | Guards are boolean predicates; mutations flip them | Should be >80% |
| RBAC permission checks | Permission functions return boolean; mutations flip access | Should be >90% |
| Task transition validation | Valid/invalid transitions are the core invariant | Should be >80% |
| Agent lifecycle decisions | Start/stop/pause decisions control resource allocation | Should be >75% |

#### What This Prevents

- Tests that execute code but don't assert behavior (assertion-free tests)
- Tests that pass for the wrong reasons (coincidental correctness)
- Regression in test quality over time (mutation score is a ratchetable metric)
- False confidence from high coverage numbers

#### Maturity Path

1. **Phase 1:** Run Stryker on state machine and RBAC code; establish baseline mutation score
2. **Phase 2:** Add to CI on changed files only (incremental mode)
3. **Phase 3:** Expand to all service code; set minimum mutation score threshold

---

## Strategic Framework 5: Runtime Verification & Invariant Monitoring

**Priority: P2 | Strategic Impact: High | Maturity: Emerging for Agent Platforms**

### Why This Matters

Static analysis and testing verify code before deployment. Runtime verification catches issues that testing missed — particularly important for an agent platform where real-world inputs are unpredictable and concurrent agent execution creates emergent behavior.

### The Framework

A three-layer runtime verification system:

#### Layer 1: Invariant Assertions

Embed `invariant()` checks at critical points that verify preconditions and postconditions at runtime.

| Assertion Point | Invariant | What Violation Indicates |
|----------------|-----------|-------------------------|
| State transitions | Source state is valid for event | Concurrent modification or missed guard |
| Database updates | `changes === expected_count` | Race condition or stale data |
| Agent lifecycle | Container exists before exec | Resource cleanup race |
| Plan approval | Plan is pending before approval | Double-approval or stale UI |
| Worktree operations | Branch exists before merge | Premature cleanup |

**Behavior:** Throws in development/test; logs structured alert + continues in production.

#### Layer 2: State Machine Telemetry

Structured logging of all state machine transitions with enough context for anomaly detection.

```
{ machine: "task", from: "in_progress", to: "waiting_approval", event: "COMPLETE",
  taskId: "...", duration_in_state_ms: 45200, guard_failures: 0 }
```

**What anomalies reveal:**
- Transitions that never happen in production (dead code in machine)
- Unexpected transition frequencies (looping between states)
- States with extreme dwell times (stuck workflows)
- Guard failures correlating with specific client versions or user actions

#### Layer 3: Contract Monitoring at Service Boundaries

Lightweight runtime validation that service inputs and outputs match their contracts (Zod schemas) — not just at API boundaries (where Zod is already used) but at internal service boundaries.

**When to use:** Sample-based (validate 1% of internal calls in production) to avoid performance overhead while still catching contract violations over time.

#### What This Prevents

- Production incidents from edge cases that testing didn't cover
- Slow-building inconsistencies from race conditions in concurrent agent execution
- State machine bugs that only manifest under real-world event ordering
- Data corruption that propagates silently before detection

---

## Strategic Framework 6: Sandbox Verification & Escape Testing

**Priority: P2 | Strategic Impact: Critical for Trust Model | Maturity: Established in Security**

### Why This Matters

AgentPane's value proposition depends on safe agent execution. If an agent can escape the sandbox, access the host filesystem, or exfiltrate data over the network, the entire trust model breaks. The K8s deployment path drops all capabilities and enforces `seccompProfile: RuntimeDefault`. The Docker path does not.

### The Framework

**Automated sandbox boundary verification** — a test suite that creates real containers and systematically attempts to violate isolation guarantees.

#### Verification Matrix

| Boundary | Test Method | Expected Result |
|----------|-----------|----------------|
| **Filesystem isolation** | Read `/etc/hostname`, `/proc/1/environ` | Access denied |
| **Path traversal** | Symlink `/workspace/escape` → `/` | Blocked by `realpath()` validation |
| **Network isolation** (`none` mode) | `curl https://example.com` | Connection refused |
| **Capability restriction** | `mount`, `mknod`, `raw socket` | Operation not permitted |
| **Docker socket** | Access `/var/run/docker.sock` | Not mounted / access denied |
| **Resource limits** | Allocate beyond memory limit | OOM killed |
| **User isolation** | Attempt `sudo` beyond allowlist | Permission denied |
| **Process isolation** | List host processes via `/proc` | Only container processes visible |

#### Continuous Verification

- Run escape test suite on every change to Docker provider, Dockerfile, or sandbox configuration
- Run full suite weekly as a scheduled CI job (to catch OS/runtime regressions)
- Include in release validation checklist

#### What This Prevents

- Container configuration regressions that weaken isolation
- New Docker provider code that accidentally grants capabilities
- Dockerfile changes that widen the attack surface
- Confidence gap between K8s (hardened) and Docker (less hardened) deployment paths

---

## Priority Ranking & Justification

| Rank | Framework | Priority | Justification |
|------|-----------|----------|--------------|
| 1 | **Specification-as-Contract Verification** | P3 | The spec library is a unique strategic asset. Without automated enforcement, specs drift and lose value. 3 of 4 state machines already drifted. This framework prevents an entire class of inconsistency and makes specs load-bearing infrastructure. Deprioritized — specs are reference material, not blocking production quality. |
| 2 | **Property-Based & Model-Based Testing** | P0 | State machines govern all system behavior. Example-based tests cover known cases; property-based testing finds unknown edge cases. For an agent platform where invalid states mean uncontrolled code execution, this is a safety-critical investment. |
| 3 | **Security Static Analysis Pipeline** | P0 | The codebase already has good security patterns, but enforcement is manual (code review). Semgrep rules make security patterns impossible to bypass — every PR is checked. Critical for a platform that runs arbitrary AI-generated code. |
| 4 | **Mutation Testing for Test Quality** | P1 | 7,308 tests is impressive by count, but count doesn't equal quality. Mutation testing reveals whether tests actually verify behavior. This is the difference between "code was executed" and "code was verified." |
| 5 | **Runtime Verification & Invariant Monitoring** | P1 | Complements pre-deployment verification with production monitoring. Catches emergent behavior from concurrent agent execution that no test can predict. Becomes more valuable as the platform scales. |
| 6 | **Sandbox Verification & Escape Testing** | P2 | Critical for the trust model but narrow in scope (only touches sandbox code). High impact when sandbox configuration changes; otherwise runs as a steady-state validation. |

---

## Framework Interaction Model

The 6 frameworks are not independent — they reinforce each other:

```
                    ┌──────────────────────────────────┐
                    │  1. Spec-as-Contract Verification │
                    │  (defines what "correct" means)   │
                    └──────────┬───────────┬────────────┘
                               │           │
              ┌────────────────┘           └────────────────┐
              ▼                                             ▼
┌─────────────────────────┐                   ┌─────────────────────────┐
│ 2. Property-Based Tests │                   │ 3. Security SAST        │
│ (verify state machines  │                   │ (enforce security       │
│  against spec props)    │                   │  patterns in code)      │
└───────────┬─────────────┘                   └───────────┬─────────────┘
            │                                             │
            ▼                                             ▼
┌─────────────────────────┐                   ┌─────────────────────────┐
│ 4. Mutation Testing     │                   │ 6. Sandbox Escape Tests │
│ (verify test quality    │                   │ (verify isolation       │
│  for property tests)    │                   │  boundaries hold)       │
└───────────┬─────────────┘                   └─────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│ 5. Runtime Verification │
│ (catch what all above   │
│  frameworks missed)     │
└─────────────────────────┘
```

- **Specs** define correctness → **property tests** verify correctness systematically → **mutation tests** verify the property tests themselves
- **Security SAST** prevents classes of vulnerabilities → **sandbox escape tests** verify the trust boundary
- **Runtime verification** is the final safety net for everything the other 5 frameworks missed

---

## Tools & Technology Recommendations

| Framework | Primary Tool | Why This Tool | Alternatives Considered |
|-----------|-------------|--------------|------------------------|
| Spec verification | Custom TypeScript script | Specs use project-specific markdown format; no off-the-shelf tool fits | Spectral (OpenAPI-only), custom Cucumber |
| Property-based testing | [fast-check](https://github.com/dubzzz/fast-check) | Best TS support, Vitest integration, model-based testing support, active maintenance | jsverify (unmaintained), Hypothesis (Python only) |
| Security SAST | [Semgrep](https://semgrep.dev/) | Custom rule authoring, TS support, fast incremental scanning, free OSS tier | CodeQL (slower, GitHub-only CI), ESLint security plugins (weaker analysis) |
| Mutation testing | [Stryker](https://stryker-mutator.io/) | Vitest support, incremental mode, mature ecosystem | No viable TS alternatives |
| Runtime invariants | [tiny-invariant](https://github.com/alexreardon/tiny-invariant) | Zero-dependency, tree-shakeable, standard pattern | Zod assertions (heavier), Node.js assert (no prod mode) |
| Sandbox testing | Vitest + Docker API | Tests need real containers; existing test infra (dockerode) works | Dedicated container testing frameworks (overkill) |

---

## Implementation Sequence

```
Quarter 1 (Now) -- COMPLETED 2026-03-26
├── Framework 2: Property-Based Testing (P0) ✅
│   ├── Added fast-check v4.6.0 dependency
│   ├── 54 property tests for all 4 state machines (invariants, reachability, idempotence, guard boundaries)
│   ├── 5 model-based tests for task lifecycle (fc.commands + fc.modelRun)
│   ├── Files: src/lib/state-machines/__tests__/state-machines.property.test.ts (1308 lines)
│   └── Files: src/lib/state-machines/__tests__/task-workflow.model.test.ts
│
├── Framework 3: Security SAST (P0) ✅
│   ├── 13 Semgrep rules across 6 files in .semgrep/rules/
│   │   ├── shell-safety.yml (4 rules: sh-c interpolation, duplicate shellEscape, exec validation, prefer array spawn)
│   │   ├── deserialization.yml (2 rules: JSON.parse as type, JSON.parse no try/catch)
│   │   ├── error-handling.yml (2 rules: empty catch, error context lost)
│   │   ├── container-security.yml (2 rules: Docker no CapDrop, no SecurityOpt)
│   │   ├── path-safety.yml (2 rules: file ops without boundary check, missing realpath)
│   │   └── type-safety.yml (1 rule: double cast warning)
│   ├── CI job added to .github/workflows/ci.yml (two-pass: ERROR blocks, WARNING reports)
│   ├── npm scripts: semgrep, semgrep:error
│   └── Pre-commit hook in .pre-commit-config.yaml
│
Quarter 2
├── Framework 4: Mutation Testing (P1)
│   ├── Add Stryker with Vitest plugin
│   ├── Baseline critical paths (state machines, RBAC)
│   └── Set minimum score thresholds
│
├── Framework 5: Runtime Verification (P1)
│   ├── Add invariant assertions at state transitions
│   ├── Implement state machine telemetry
│   └── Sample-based contract monitoring
│
Quarter 3+
├── Framework 6: Sandbox Escape Testing (P2)
│   ├── Build escape test suite
│   ├── Add to CI for sandbox-related changes
│   └── Schedule weekly full suite runs
│
└── Framework 1: Spec-as-Contract (P3)
    ├── Build verify-specs.ts script
    ├── Add to CI pipeline
    └── Fix existing drift (state machines, naming)
```

---

## Success Metrics

| Metric | What It Measures | Target |
|--------|-----------------|--------|
| Spec drift count | # of verifiable spec claims that don't match code | 0 (enforced in CI) |
| Property test coverage | # of state machines with property tests | 4/4 |
| Mutation score (critical paths) | % of mutations caught by tests | >75% |
| Semgrep rule count | # of project-specific security rules | 15+ |
| Mean time to drift detection | How quickly spec-code divergence is caught | <1 PR (caught in CI) |
| Sandbox boundary violations | # of escape test failures | 0 |
| Runtime invariant violations | # of invariant failures in production | Tracked, trending to 0 |

---

## Appendix: Current State Evidence

### A. Testing Infrastructure

- 7,308 test cases across 5 Vitest projects (unit, jsdom, db, integration, functional)
- 141 state machine tests, 962 route tests, 1,652 service tests, 320 component tests
- 260 Playwright E2E tests (not in CI)
- Statement coverage: 69%, Branch coverage: 62%
- CI: 3-shard unit/db + 2-shard integration/functional

### B. Security Posture

- Docker sandbox: running but without `CapDrop`; K8s sandbox: fully hardened
- Auth: triple-gated dev bypass, SHA-256 token hashing, RBAC with role ceiling
- Input validation: Zod at API boundaries, shell escaping, path traversal checks
- 1 MEDIUM finding (Docker capabilities), 7 LOW findings

### C. Code Quality

- TypeScript strict mode with `noUncheckedIndexedAccess`
- `Result<T, E>` pattern throughout services
- 27 empty catch blocks across 11 production files
- 12+ unsafe `JSON.parse` + type assertion casts
- Dual schema (SQLite/PostgreSQL) with index drift

### D. Spec Alignment

- 3 of 4 state machine specs drifted from implementation
- 26 of 35+ services have no specification
- 18 of 25 error domains undocumented
- Spec-wide "project" vs "codespace" naming inconsistency
- README metric claims don't match actual counts
