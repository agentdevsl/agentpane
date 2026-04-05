---
name: "provider-test-speed"
description: "Analyze and optimize Terraform provider acceptance test execution for maximum speed with 100% pass rate. Use when the user wants to run tests faster, analyze test timing, find slow tests, parallelize test execution, or optimize their test suite's throughput. Also use when the user mentions "test speed", "slow tests", "parallel tests", "test performance", "speed up tests", or asks why tests take so long."
source: image
---
# Provider Test Speed

Produce a parallel execution script that runs Terraform provider acceptance
tests at maximum speed while maintaining a 100% pass rate.

## Core Principle: Resource-Type Grouping

The grouping strategy is resource-type-aware, not pure time-balancing.
A naive approach (LPT/bin-packing by duration) mixes all test types across
groups for perfect time balance — but in practice this causes backend
saturation because every group hammers the same async job queue
simultaneously. Resource-type grouping keeps related tests together so
each group hits a different API surface, avoiding contention:

- Tests that **trigger long-running backend operations** (job launches,
  workflow runs, provisioning) go in dedicated groups, separated from
  CRUD-only and data-source tests.
- Tests for the **same resource type run sequentially** within a group
  (shared mutable state).
- Tests for **different resource types run in parallel** across groups
  (independent API endpoints).
- **Data source tests** (read-only) are safe to parallel with everything
  and can be combined with fast CRUD tests.

After grouping by resource type, balance group sizes so no single group
dominates wall time. Merge small independent resource groups together.

## Workflow

### 1. Discover Tests

Find all acceptance tests (functions prefixed `TestAcc`):

```bash
# Find the test package
find . -name '*_test.go' -path '*/internal/*' | head -5

# List all acceptance tests
grep -rn 'func TestAcc.*\(t \*testing.T\)' <test-package>/ --include='*_test.go'
```

Build a test inventory: test name, file, resource type (inferred from file
name or test prefix).

### 2. Analyze Timing (if output available)

Parse `--- PASS` / `--- FAIL` lines from prior test output to extract
per-test durations. Calculate total wall time, sum of durations, and
parallelism ratio (sum / wall_time; 1.0 = sequential).

### 3. Classify Into Parallel Groups

**Target 4-5 consolidated groups.** This range is the sweet spot:

- **3 or fewer** can be SLOWER than sequential — the critical-path group
  contains most tests and all others finish early and idle.
- **6+** overwhelms most test environments with concurrent API clients,
  causing `Client.Timeout exceeded while awaiting headers`.

Consolidation strategy:

- Combine resource tests + their associated action/operation tests
- Combine all read-only data source tests into one group
- Combine small independent resource groups to balance load
- Balance group sizes so no single group dominates wall time

### 4. Generate the Parallel Execution Script

Produce a self-contained bash script with these requirements:

**Pre-compiled test binary (critical):**
Compile the test binary ONCE with `go test -c -o <binary>`, then run that
binary directly for each group. Each group invokes the binary with
`-test.*` flags (NOT `go test` with standard flags). This avoids N
parallel compilations and I/O contention:

```bash
# Step 1: Compile once
TEST_BINARY="${LOG_DIR}/provider.test"
go test -c -o "$TEST_BINARY" ./internal/provider/

# Step 2: Run the BINARY (not go test) for each group
TF_ACC=1 "$TEST_BINARY" \
  -test.count=1 \
  -test.timeout 30m \
  -test.run "^TestAccResource_|^TestAccResourceAction_" \
  -test.v \
  > "$LOG_DIR/group_1.log" 2>&1 &
```

The binary uses `-test.run`, `-test.count`, `-test.timeout`, `-test.v`
(with `test.` prefix). Standard `go test` flags like `-run`, `-count`,
`-timeout` do NOT work on the compiled binary.

**Exponential backoff retry for transient failures:**
Under parallel load, connection timeouts and server contention cause
transient failures. Include a retry wrapper that:

- Retries a failed group up to 2 additional times (3 total attempts)
- Uses exponential backoff delays: 15s, 45s
- Only retries on timeout-related failures (Client.Timeout, connection
  refused, EOF) — NOT assertion failures or panics
- Logs retry attempts to the group's log file

**Additional script requirements:**

- Set `TF_ACC=1` on every test process
- Stagger group launches by 2-3 seconds to avoid initial connection storms
- Log each group to a separate file
- Wait for all groups, collect exit codes
- Parse per-test durations from logs and report a summary table
- Exit non-zero if any group failed
- Accept the same env vars as the provider's existing test setup

**Timing parser note:** `grep` interprets patterns starting with `---` as
flags. Always use `grep -oE -e 'pattern'` (with explicit `-e`) when the
pattern starts with dashes.

Save the script to `testing/run-parallel.sh` and make it executable.

### 5. Run and Validate

Execute the parallel script and verify:

- **100% pass rate** — every test must pass
- **Timing improvement** — compare wall time against sequential baseline

If any group fails, check for connection timeouts first. Timeouts usually
mean too many parallel groups. Reduce group count by merging the smallest
groups together and retry.

If failures persist after reducing groups, re-run the failing group alone
to confirm whether the failure is a parallelism conflict or a pre-existing
issue.

Report results as:

```
## Test Execution Results

| Metric              | Sequential | Parallel | Speedup |
|---------------------|------------|----------|---------|
| Wall time           | Xs         | Ys       | N.Nx    |
| Tests passed        | N/N        | N/N      | -       |
| Groups              | 1          | G        | -       |
```

## Key Constraints

- Never sacrifice correctness for speed. 100% pass rate is non-negotiable.
- Always pre-compile the test binary once, then run the binary per group.
  Never use `go test` to run the groups — always use the compiled binary
  with `-test.*` flags.
- If a parallel strategy causes flaky failures, fall back to sequential for
  that group and report which tests conflicted.
