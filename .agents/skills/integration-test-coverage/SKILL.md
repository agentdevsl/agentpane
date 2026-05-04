---
name: integration-test-coverage
description: "Deterministic integration test coverage analysis using off-the-shelf tooling. Use this skill whenever the user asks about test coverage, coverage gaps, untested code, what needs testing, or wants to improve integration test coverage. Also trigger when the user says 'run coverage', 'check coverage', 'coverage report', 'what's untested', 'find gaps', or has just implemented a feature and wants to know what integration tests are missing. This skill runs real tools and produces data-driven reports — not guesswork."
---

# Deterministic Integration Test Coverage

Use off-the-shelf tools to produce reproducible, data-driven coverage gap reports. The model is already good at writing tests — the skill's value is in deterministic DETECTION of what's missing.

## Step 1: Run integration test coverage

Generate a coverage report scoped to integration tests only. This tells you exactly which source lines are exercised by integration tests.

### Vitest (most common)

```bash
# Check for vitest config with project definitions
grep -l "projects\|workspace" vitest.config.* vite.config.* 2>/dev/null
```

If the project has an `integration` test project:

```bash
npx vitest run --project integration --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportsDirectory=coverage/integration
```

If no separate project, filter by test directory:

```bash
npx vitest run tests/integration/ --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportsDirectory=coverage/integration
```

For Jest:

```bash
npx jest --testPathPattern='integration|__integration__' --coverage --coverageDirectory=coverage/integration --coverageReporters=json-summary --coverageReporters=json
```

### Read the coverage summary

```bash
cat coverage/integration/coverage-summary.json | head -100
```

The `json-summary` report has per-file stats:

```json
{
  "src/services/task.service.ts": {
    "lines": { "total": 500, "covered": 320, "pct": 64 },
    "branches": { "total": 80, "covered": 45, "pct": 56.25 },
    "functions": { "total": 40, "covered": 28, "pct": 70 }
  }
}
```

Files with `0%` line coverage have zero integration test coverage — these are the priority gaps.

## Step 2: Identify files with zero integration coverage

Parse the coverage summary to find uncovered source files:

```bash
# List source files with 0% integration test line coverage
node -e "
const s = require('./coverage/integration/coverage-summary.json');
Object.entries(s).filter(([f,d]) => f !== 'total' && d.lines.pct === 0)
  .forEach(([f,d]) => console.log(f));
"
```

For a broader view of low-coverage files:

```bash
# Files under 20% line coverage from integration tests
node -e "
const s = require('./coverage/integration/coverage-summary.json');
Object.entries(s)
  .filter(([f,d]) => f !== 'total' && d.lines.pct < 20)
  .sort((a,b) => a[1].lines.pct - b[1].lines.pct)
  .forEach(([f,d]) => console.log(d.lines.pct.toFixed(0).padStart(3) + '% ' + f));
"
```

## Step 3: Compare unit vs integration coverage (optional)

Run coverage for unit tests separately, then compare. Source files covered by unit tests but NOT integration tests are prime candidates for new integration tests.

```bash
# Unit test coverage
npx vitest run --project unit --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/unit

# Find files covered by unit tests but not integration tests
node -e "
const unit = require('./coverage/unit/coverage-summary.json');
const integ = require('./coverage/integration/coverage-summary.json');
Object.entries(unit)
  .filter(([f,d]) => f !== 'total' && d.lines.pct > 0)
  .filter(([f]) => !integ[f] || integ[f].lines.pct === 0)
  .forEach(([f,d]) => console.log('UNIT-ONLY: ' + f + ' (' + d.lines.pct.toFixed(0) + '% unit)'));
"
```

## Step 4: Check which tests cover a specific file

Use Vitest's built-in `related` command to find which integration tests touch a file:

```bash
# Which integration tests cover task.service.ts?
npx vitest related src/services/task.service.ts --project integration --reporter=verbose --run
```

If no tests are found, that file has an integration coverage gap.

## Step 5: Mutation testing (optional, deeper analysis)

Coverage tells you which lines were *executed*. Mutation testing tells you which lines were actually *verified* — a test that calls a function but never checks the return value shows 100% coverage but 0% mutation kill rate.

### Stryker Mutator

```bash
# Install if not present
npm install -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker

# Run mutation testing on a specific service
npx stryker run --mutate 'src/services/task.service.ts'
```

Surviving mutants = code that tests execute but don't verify. These are the highest-value gaps to fill.

### Interpreting results

- **Killed**: Test caught the mutation — good
- **Survived**: Tests passed despite code change — gap (test executes but doesn't verify)
- **No coverage**: No test reaches this code at all — gap
- **Timeout**: Mutation caused infinite loop — boundary condition not tested

## Step 6: Dependency graph analysis (optional)

Map service-to-service dependencies to find untested integration points.

### dependency-cruiser

```bash
# Install
npm install -D dependency-cruiser

# Visualize service dependencies
npx depcruise src/services --include-only "^src/services" --output-type text

# Find circular dependencies (hard to integration test)
npx depcruise src --include-only "^src" --output-type err --no-config

# JSON output for programmatic analysis
npx depcruise src/services --include-only "^src" --output-type json > deps.json
```

Cross-reference the dependency edges against integration test files to find untested service-to-service interactions.

## Step 7: Present the report

After running the tools, present a structured report:

```markdown
## Integration Test Coverage Report

### Source files with ZERO integration coverage
| File | Unit Coverage | Status |
|------|-------------|--------|
| src/services/foo.service.ts | 85% | No integration tests |
| src/services/bar.service.ts | 72% | No integration tests |

### Low integration coverage (< 30%)
| File | Integration % | Lines Covered/Total |
|------|--------------|-------------------|
| src/services/baz.service.ts | 12% | 15/125 |

### Surviving mutants (tested but not verified)
| File | Survived | Total | Kill Rate |
|------|----------|-------|-----------|
| src/services/task.service.ts | 8 | 45 | 82% |

### Recommended actions (priority order)
1. Add integration tests for `foo.service.ts` — 0% coverage, high-traffic service
2. Add assertions for `task.service.ts` lines 120-135 — 8 surviving mutants
3. Add integration tests for `bar.service.ts` — only covered by unit tests
```

Then write tests for the identified gaps, following the project's existing test patterns and conventions.
