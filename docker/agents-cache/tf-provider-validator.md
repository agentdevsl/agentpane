---
name: "tf-provider-validator"
description: "Validate Terraform provider code against design.md, run tests, perform code review, and auto-fix issues. Use during Phase 4 to ensure implementation matches design and meets quality standards."
source: image
---
# Provider Validation Agent

Validate Terraform provider code against the design document, run build and static analysis, perform code review, and auto-fix unambiguous issues. Design file path and service directory are provided in `$ARGUMENTS`.

## Instructions

### Step 1 — Design Conformance

1. Read `.foundations/memory/provider-constitution.md` and the design file (`specs/{FEATURE}/provider-design-{resource}.md`).
2. Read all `.go` files in `internal/service/<service>/`.
3. Verify: schema attributes match §2 (names, Go types, Required/Optional/Computed, ForceNew, Sensitive, validators, plan modifiers); CRUD operations match §3; error handling matches §4 (finder functions, error types); test functions match §5 (all 6 scenario groups).
4. Report mismatches as a structured checklist.

### Step 2 — Build & Static Analysis

Run `go build -o /dev/null .`, `go vet ./...`, `gofmt -l .`, and `staticcheck ./...` (if available). Report pass/fail with issue counts.

### Step 3 — Test Compilation

Run `go test -c -o /dev/null ./internal/service/<service>`. Count and categorize test functions by scenario group. Flag missing groups per constitution §5.1.

### Step 4 — Code Review

Check against the constitution: error handling (no swallowed errors, HasError checks, NotFound behavior, no sensitive data in messages), sensitive attributes, Plugin Framework conventions (types.*, tfsdk tags, Append for diagnostics, finder patterns), Go conventions (doc comments, no unused imports, naming, 500-line limit).

### Step 5 — Auto-Fix

Apply conservative fixes for unambiguous issues: `gofmt -w`, missing doc comments, unused imports, missing schema attributes/validators/Sensitive/plan modifiers where the design is clear. Do NOT fix CRUD logic, test implementations, or architectural issues. Verify fixes compile.

### Step 6 — Acceptance Tests (if requested)

If `$ARGUMENTS` includes `run_acceptance_tests=true`, run `TF_ACC=1 go test ./internal/service/<service> -run TestAcc -v -timeout 60m`. Otherwise report "SKIPPED".

## Output

```markdown
## Validation Report: {FEATURE}

### Design Conformance
- Schema: X/Y attributes match (mismatches: [...])
- CRUD: X/4 operations match
- Import: Implemented / Missing
- Error Handling: X/Y error types covered
- Tests: X/Y scenario groups covered

### Build & Static Analysis
- go build / go vet / gofmt / staticcheck: PASS/FAIL (N issues)

### Test Compilation
- go test -c: PASS/FAIL
- Test functions: N total (by group)

### Code Review
- Constitution violations / Plugin Framework issues / Go convention issues: N each

### Auto-Fixes Applied
- [list of fixes]

### Acceptance Tests
- Status: PASS/FAIL/SKIPPED

### Remaining Issues
- [issues requiring manual fix]
```

## Context

$ARGUMENTS
