# Terraform Provider Development Constitution

**Organization**: [Your Organization Name]
**Version**: 1.0.0
**Effective Date**: February 2026
**Purpose**: Non-negotiable principles for enterprise Terraform provider development using the Plugin Framework
**Authority**: This document governs what correct provider code looks like. Workflow mechanics live in orchestrator skills. Agent behavior lives in AGENTS.md. If a rule exists here, it is not duplicated elsewhere.

---

## 1. Core Principles

### 1.1 Plugin Framework First

Provider resources MUST be authored using the [Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework), not SDKv2.

- Resources MUST implement the `resource.Resource` interface with proper CRUD methods
- Schema MUST use `schema.Schema` with typed attributes (`schema.StringAttribute`, `schema.Int64Attribute`, etc.)
- State management MUST use `types.*` values (not raw Go types) in model structs
- Plan modifiers MUST be used for ForceNew (`RequiresReplace()`) and computed attributes (`UseStateForUnknown()`)
- Validators MUST be applied to all user-facing attributes with constraints
- Research API/SDK docs and Plugin Framework documentation before writing any resource code

### 1.2 Security-First Error Handling

Provider code MUST never expose secrets or sensitive data in error messages, diagnostics, or logs.

- Error messages MUST NOT include API keys, tokens, passwords, or other credentials
- Sensitive attributes MUST be marked with `Sensitive: true` in the schema
- Diagnostics MUST provide actionable error messages without leaking implementation details
- Log output MUST NOT contain request/response bodies with sensitive fields
- Provider configuration credentials MUST be inherited from consumer configuration

### 1.3 Test Stubs Before Implementation

Acceptance test stubs MUST be written and compile before CRUD implementation begins. Stubs define the test contract (function signatures, config functions, check functions) with `t.Skip("not implemented")` bodies. CRUD implementation then fills in the stubs incrementally. Full test execution (`TF_ACC=1`) occurs during validation (Phase 4).

- Every resource MUST have test files in `internal/service/<service>/`
- Test stubs MUST cover: basic, disappears, full features, update, validation, error handling
- Test function signatures and config functions MUST be defined before implementation
- Test compilation (`go test -c`) MUST pass from the first checklist item onward
- Tests MUST use random prefixes (`sdkacctest.RandomWithPrefix(acctest.ResourcePrefix)`) for resource isolation
- Sweep functions MUST be provided for test resource cleanup

### 1.4 Single Design Document

All planning produces one file: `specs/{FEATURE}/provider-design-{resource}.md`.

- Schema attributes, CRUD operations, error handling, and test scenarios each appear exactly once
- No separate specification, plan, contract, data model, or task files
- The design document is the sole source of truth for the resource implementation

---

## 2. Code Standards

### 2.1 File Organization

Provider resources MUST follow the standard service package structure:

```
internal/service/<service>/
├── <resource_name>.go              # Resource implementation (schema, CRUD, model)
├── <resource_name>_test.go         # Acceptance tests
├── <resource_name>_data_source.go  # Data source (if applicable)
├── <resource_name>_data_source_test.go  # Data source tests (if applicable)
├── find.go                         # Finder functions (findByID, findByName)
├── status.go                       # Status functions (statusResource)
├── wait.go                         # Waiter functions (waitCreated, waitDeleted)
├── exports_test.go                 # Test exports
├── sweep_test.go                   # Sweep functions for test cleanup
└── service_package_gen.go          # Auto-generated service registration

website/docs/r/
└── <service>_<resource_name>.html.markdown  # Resource documentation

website/docs/d/
└── <service>_<resource_name>.html.markdown  # Data source documentation (if applicable)
```

Rules:

- Resource file MUST contain: type definition, Metadata, Schema, Create, Read, Update, Delete, and model struct
- Finder, status, and waiter functions MUST be in separate files when shared across resources
- Test files MUST be in the same package as the resource
- No single file MAY exceed 500 lines — split large resources into logical files
- Documentation MUST follow the `.html.markdown` format with frontmatter

### 2.2 Naming

- Resource types: `resourceExample` (unexported struct), `NewResourceExample()` (exported constructor)
- Finder functions: `findExampleByID`, `findExampleByName`
- Status functions: `statusExample`
- Waiter functions: `waitExampleCreated`, `waitExampleDeleted`
- Test functions: `TestAccExample_basic`, `TestAccExample_disappears`, `TestAccExample_fullFeatures`
- Config functions: `testAccExampleConfig_basic`, `testAccExampleConfig_fullFeatures`
- Model structs: `resourceExampleModel` (unexported)
- Names MUST follow Go conventions: camelCase for unexported, PascalCase for exported
- Names MUST NOT contain sensitive information (account IDs, secrets, PII)

### 2.3 Model Structs

Every resource MUST define a model struct using `types.*` values:

```go
type resourceExampleModel struct {
    ID          types.String `tfsdk:"id"`
    Name        types.String `tfsdk:"name"`
    ARN         types.String `tfsdk:"arn"`
    Description types.String `tfsdk:"description"`
}
```

Rules:

- MUST use `types.String`, `types.Int64`, `types.Bool`, `types.List`, `types.Set`, `types.Map` — never raw Go types
- MUST include `tfsdk` struct tags matching schema attribute names
- Nested blocks MUST use `types.Object` or dedicated nested model structs with `tfsdk` tags

### 2.4 Schema Attributes

Every attribute MUST include:

- `Description` — purpose and valid values
- Appropriate mode: `Required`, `Optional`, `Computed`, or combinations
- `Sensitive: true` — for security-sensitive values
- `Validators` — for all user-facing attributes with constraints

Attributes SHOULD include:

- `PlanModifiers` — `RequiresReplace()` for ForceNew, `UseStateForUnknown()` for stable computed values
- `Default` — sensible defaults where applicable

### 2.5 Error Handling Patterns

- CRUD operations MUST check `resp.Diagnostics.HasError()` after reading plan/state
- Create/Update MUST use `resp.Diagnostics.AddError()` with structured error titles
- Read MUST handle NotFound by calling `resp.State.RemoveResource(ctx)` and returning
- Delete MUST silently succeed if the resource is already gone (NotFound)
- Finder functions MUST wrap NotFound errors using `retry.NotFoundError`
- Error messages MUST follow format: `"Error {verb}ing {ResourceType}"` as title, details as body

---

## 3. Security and Compliance

### 3.1 Sensitive Attributes

- Attributes containing secrets (passwords, tokens, API keys) MUST be marked `Sensitive: true`
- Sensitive attributes MUST NOT appear in error messages or diagnostics
- Sensitive attributes MUST NOT be logged at any log level
- Plan output MUST redact sensitive values (handled automatically by Plugin Framework when `Sensitive: true`)

### 3.2 Credential Handling

- Provider configuration credentials MUST be inherited from the consumer's provider block
- Resources MUST NOT define credential-related attributes (access keys, secret keys, tokens)
- Resources MUST NOT hardcode credentials or endpoints
- Provider MUST support environment variable fallback for credentials following cloud provider conventions

### 3.3 Input Validation

- All user-facing string attributes MUST have length or format validators
- Enum-like attributes MUST use `stringvalidator.OneOf()` or equivalent
- Numeric attributes with bounds MUST use `int64validator.Between()`, `AtLeast()`, or `AtMost()`
- List/Set attributes with size constraints MUST use `listvalidator.SizeAtLeast()` or `SizeAtMost()`
- Validation error messages MUST be clear and actionable

---

## 4. Version and Dependency Management

### 4.1 Go Module Versioning

- `go.mod` MUST declare Go version >= 1.21
- Plugin Framework dependency MUST use a minimum version constraint
- Dependencies MUST be managed via `go mod tidy`
- MUST NOT use `replace` directives in released code

### 4.2 Plugin Framework Constraints

- MUST use `terraform-plugin-framework` (not `terraform-plugin-sdk`)
- MUST use `terraform-plugin-testing` for acceptance tests
- Provider protocol MUST be v5 or later (`terraform-plugin-go`)
- Version constraints SHOULD use the minimum version that supports required features

### 4.3 Releases

- Semantic versioning: major (breaking provider changes), minor (new resources/data sources), patch (bug fixes/docs)
- Git tags MUST use `v` prefix: `v1.0.0`
- Release requires: all tests pass, documentation complete, CHANGELOG updated
- CHANGELOG entries MUST follow the provider's changelog format

---

## 5. Testing and Validation

### 5.1 Test Coverage

Every resource MUST have acceptance tests covering:

| Scenario | Purpose | Test Function Pattern |
|----------|---------|----------------------|
| Basic | Minimal configuration, verify resource creation and attributes | `TestAcc{Resource}_basic` |
| Disappears | Resource deleted outside Terraform, verify graceful handling | `TestAcc{Resource}_disappears` |
| Full features | All optional attributes set, verify complete configuration | `TestAcc{Resource}_fullFeatures` |
| Update | In-place update of mutable attributes, verify state changes | `TestAcc{Resource}_update` |
| Validation | Invalid inputs rejected with clear error messages | `TestAcc{Resource}_validation` |
| Error handling | API errors handled gracefully (conflict, throttle) | `TestAcc{Resource}_errorHandling` |

### 5.2 Validation Pipeline

Every resource MUST pass before release:

| Check | Tool | Blocks Release |
|-------|------|:-:|
| Compilation | `go build -o /dev/null .` | Yes |
| Static analysis | `go vet ./...` | Yes |
| Formatting | `gofmt -l .` | Yes |
| Test compilation | `go test -c -o /dev/null ./internal/service/<service>` | Yes |
| Acceptance tests | `TF_ACC=1 go test ./internal/service/<service> -v -timeout 60m` | Yes |
| Static checking | `staticcheck ./...` (if available) | Advisory |

### 5.3 Test Organization

```
internal/service/<service>/
  <resource>_test.go            # All acceptance tests for the resource
  exports_test.go               # Test exports (resource constructors, finder functions)
  sweep_test.go                 # Sweep functions for test resource cleanup
```

Each test function maps to a scenario group in `provider-design-{resource}.md` Section 5.

### 5.4 Test Isolation

- Resource names MUST use random prefixes: `sdkacctest.RandomWithPrefix(acctest.ResourcePrefix)`
- Tests MUST NOT depend on pre-existing infrastructure (except provider-level prerequisites)
- Tests MUST clean up via `CheckDestroy` functions
- Sweep functions MUST be provided for automated cleanup of leaked test resources

---

## 6. Change Management

### 6.1 Git Workflow

- Direct commits to `main` PROHIBITED
- All changes MUST be made via feature branches
- Pull requests with human review REQUIRED for all merges
- MUST NOT commit secrets, credentials, or sensitive data
- Test configurations MUST use generated values, not hardcoded secrets

### 6.2 Design Approval

Issue-driven workflow MUST pause between Design and Build+Test phases for human review of the design document.

- Gate signal: "approved" or "proceed" comment on the tracking issue
- Autonomous mode: MAY skip approval only if no CRITICAL security findings exist in the design

### 6.3 Quality Gates Between Phases

All four workflow phases are mandatory and sequential. Between phases:

| Gate | Condition |
|------|-----------|
| Understand -> Design | Requirements clear. No unresolved `[NEEDS CLARIFICATION]` markers. |
| Design -> Build+Test | Design document approved. No unresolved CRITICAL findings. |
| Build+Test -> Validate | `go build` passes. All implementation checklist items complete. |
| Validate -> Complete | All validation checks from Section 5.2 pass. |

---

## 7. Operational Standards

### 7.1 Documentation Standards

- Every resource MUST have `.html.markdown` documentation in `website/docs/r/`
- Documentation MUST include: frontmatter, description, example usage (basic + advanced), argument reference, attribute reference, import section
- Data sources MUST have documentation in `website/docs/d/`
- Example HCL in documentation MUST be syntactically valid and follow Terraform style conventions

### 7.2 Changelog Entries

- Every new resource, data source, or bug fix MUST have a changelog entry
- Changelog entries MUST follow the provider's format (typically `.changelog/<description>.txt`)
- Entry types: `new-resource`, `new-data-source`, `bug`, `enhancement`, `breaking-change`

### 7.3 Pre-Submission Checklist

- [ ] Code compiles: `go build -o /dev/null .`
- [ ] Tests compile: `go test -c -o /dev/null ./internal/service/<service>`
- [ ] Code formatted: `gofmt -w .`
- [ ] Static analysis clean: `go vet ./...`
- [ ] All CRUD operations implemented
- [ ] Import is implemented and tested
- [ ] Disappears test included
- [ ] Documentation complete with examples
- [ ] Error messages clear and actionable (no secrets)
- [ ] Sensitive attributes marked
- [ ] Plan modifiers appropriate
- [ ] Validators cover edge cases
- [ ] Changelog entry created

---

## 8. Governance

### 8.1 Constitution Maintenance

- Platform team maintains this constitution in version control
- Major changes require security and governance team review
- Provider developers MAY propose amendments via pull request
- Constitution version MUST be referenced in agent prompts

### 8.2 Exception Process

Deviations from this constitution require:

1. Documented requirement driving the exception
2. Alternative approach with risk assessment
3. Platform team approval
4. Exception documented in code and centralized exceptions register
5. Review during next policy update cycle

### 8.3 Audit and Compliance

- All provider code — AI-generated or human-authored — passes through the same policy enforcement
- Periodic audits verify constitution compliance
- Non-compliant patterns trigger constitution updates or code remediation
- Metrics track code quality, test coverage, and security posture

### 8.4 Documentation

- Every resource MUST include `.html.markdown` documentation with examples
- Complex logic MUST include inline comments explaining rationale
- Error handling patterns MUST be documented where non-obvious
- Exported types and functions MUST have Go doc comments
