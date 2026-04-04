# Terraform Module Development Constitution

**Organization**: [Your Organization Name]
**Version**: 5.0.0
**Effective Date**: February 2026
**Purpose**: Non-negotiable principles for enterprise Terraform module development
**Authority**: This document governs what correct module code looks like. Workflow mechanics live in orchestrator skills. Agent behavior lives in AGENTS.md. If a rule exists here, it is not duplicated elsewhere.

---

## 1. Core Principles

### 1.1 Module-First Architecture

Modules MUST be authored using native Terraform resources from official providers following the [standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure).

- Modules MUST expose configurable inputs with secure defaults
- Consumers MUST get a secure, working baseline without overriding anything
- Conditional resource creation MUST be supported via boolean variables (`create_*` or `enable_*`)
- Module versioning MUST follow semantic versioning with CHANGELOG entries
- Research provider docs and AWS documentation before writing any resource code

### 1.2 Security-First by Default

Module code MUST assume zero trust. Security gaps in modules propagate to every consumer.

- Encryption, access controls, and logging MUST be enabled by default
- Security-sensitive inputs MUST default to the secure option (`public_access = false`, `encryption_enabled = true`)
- Modules MUST NOT require consumers to pass credentials
- Security controls MUST be toggleable via variables; defaults MUST always be the secure option
- Security rationale MUST be documented in code comments where non-obvious

### 1.3 Tests Before Code

Test files (`.tftest.hcl`) MUST be written before the module code they validate.

- Every module MUST have test files in `tests/`
- Tests MUST cover: secure defaults, full feature set, conditional creation disabled, input validation
- Security assertions (encryption, access controls, TLS enforcement) MUST exist before feature code
- Tests SHOULD use mocks where possible for fast iteration
- Integration tests SHOULD run in CI against a sandbox workspace

### 1.4 Single Design Document

All planning produces one file: `specs/{FEATURE}/design.md`.

- Variable names, resource inventories, and validation rules each appear exactly once
- No separate specification, plan, contract, data model, or task files
- The design document is the sole source of truth for the module

---

## 2. Code Standards

### 2.1 File Organization

Root modules MUST follow the standard HashiCorp module structure:

```
/
├── main.tf              # Primary resource definitions
├── variables.tf         # Input variable declarations
├── outputs.tf           # Output value declarations
├── locals.tf            # Local value computations
├── versions.tf          # Terraform and provider version constraints
├── data.tf              # Data source definitions (if needed)
├── README.md            # Auto-generated via terraform-docs
├── CHANGELOG.md         # Version history
├── examples/
│   ├── basic/           # Minimal usage — provider config lives here
│   └── complete/        # All features enabled — provider config lives here
├── modules/             # Submodules (optional)
└── tests/               # .tftest.hcl files
```

Rules:

- Root module MUST NOT contain `provider {}` blocks — modules inherit providers from consumers
- `required_providers` and `required_version` MUST be declared in `versions.tf`
- Provider configuration (region, credentials) belongs ONLY in `examples/`
- `examples/basic/` MUST demonstrate minimum viable usage
- `examples/complete/` MUST demonstrate all features and optional configurations
- No single file MAY exceed 500 lines
- No monolithic configurations — resources MUST be logically grouped

### 2.2 Naming

- Resources: `this` for single instances (`aws_vpc.this`); descriptive names for multiples (`aws_subnet.public`, `aws_subnet.private`)
- Variables: `snake_case` with descriptive names
- Outputs: `snake_case`, mirroring resource attribute names where possible
- Boolean toggles: `create_<resource>` or `enable_<feature>`
- Names MUST NOT contain sensitive information (account IDs, secrets, PII)
- Names MUST be idempotent — no timestamps or random values unless functionally required
- Prefer `for_each` over `count` for stable resource addresses

### 2.3 Variables

Every variable MUST include:

- `description` — purpose and valid values
- `type` — explicit constraint, never implicit `any`
- `sensitive = true` — for security-sensitive values

Variables SHOULD include:

- `validation` blocks for business logic constraints
- Sensible defaults where possible — minimize required inputs
- Required variables MUST be the minimum needed for a working deployment

### 2.4 Outputs

- Outputs exposing secrets MUST be marked `sensitive = true`
- Conditional resources MUST use `try()` for graceful null handling:

  ```hcl
  output "vpc_id" {
    value = try(aws_vpc.this[0].id, null)
  }
  ```

- All outputs MUST have `description` for terraform-docs generation

### 2.5 Resource Patterns

- Conditional creation via `count` or `for_each` with enable variables
- `merge()` for tags — combine module defaults with consumer-provided tags
- `try()` and `lookup()` for safely accessing optional nested values
- `dynamic` blocks for repeatable nested configurations
- MUST NOT hardcode values that consumers should control — expose as variables with defaults

### 2.6 Code Style

- Follow the [HashiCorp Style Guide](https://developer.hashicorp.com/terraform/language/style)
- Argument ordering within blocks: required arguments, optional arguments, meta-arguments
- Auto-format with `terraform fmt`
- Complex logic MUST include inline comments explaining rationale
- All variables and outputs MUST have descriptions for terraform-docs

---

## 3. Security and Compliance

### 3.1 Secrets and Credentials

- Modules inherit providers from consumers — NEVER include `provider {}` blocks in root modules
- MUST NOT generate static credential variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or equivalent)
- Variables accepting secrets MUST be marked `sensitive = true`
- Outputs exposing secrets MUST be marked `sensitive = true`
- Provide integration points for secrets managers (accept ARNs for KMS keys, Secrets Manager) rather than managing secrets directly
- SHOULD use ephemeral resources for sensitive values where supported

### 3.2 AWS Security Baselines

These rules apply to all AWS modules. Non-AWS providers MUST add equivalent rules following this pattern.

| Control | Requirement |
|---------|-------------|
| Encryption at rest | Enabled by default. MUST NOT be disableable without an explicit variable. |
| Encryption in transit | Enforced via resource policy or platform default. Document which applies and cite evidence. |
| Public access | Blocked by default. S3: all four public access block flags `true`. |
| Security Groups | Deny all by default. Allow only specific required ports and sources. |
| IAM roles | Specific resource ARNs. No wildcards (`*`) unless unavoidable with documented justification. |
| S3 force_destroy | Configurable, default `false`. Examples MAY set `true` for testing. |
| RDS public access | MUST NOT be publicly accessible unless explicitly justified. |
| EC2 credentials | IAM instance profiles. No embedded credentials. |
| Lambda permissions | Least-privilege execution roles with specific service permissions. |

### 3.3 Tagging

- All taggable resources MUST accept a `tags` variable (`map(string)`, default `{}`)
- Module MUST merge consumer tags with required tags using `merge()`, consumer tags taking precedence
- Required tags: `Name`, `ManagedBy = "terraform"`
- Organization-specific required tags (e.g., `Environment`, `CostCenter`, `Owner`) MUST be enforced via required variables or tflint rules

---

## 4. Version and Dependency Management

### 4.1 Provider Constraints

```hcl
terraform {
  required_version = ">= 1.14"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
```

- Modules MUST declare `required_version` with a minimum Terraform version
- Provider versions MUST use `>=` in modules (not `~>`) to maximize consumer compatibility
- Use the minimum version that supports required features — do not over-constrain
- MUST NOT use `latest` or unconstrained versions

### 4.2 State Management

- Root modules MUST NOT include `backend {}` or `cloud {}` configuration blocks
- Examples MAY include backend configuration for testing
- State MUST NOT be committed to version control

### 4.3 Releases

- Semantic versioning: major (breaking interface changes), minor (new features/variables/outputs), patch (bug fixes/docs/security patches)
- Git tags MUST use `v` prefix: `v1.0.0`
- Release requires: all tests pass, examples deploy and destroy cleanly, documentation current, CHANGELOG updated

---

## 5. Testing and Validation

### 5.1 Test Coverage

Every module MUST have `.tftest.hcl` files in three categories:

| Category | Provider | Command | Purpose |
|----------|----------|---------|---------|
| Unit tests | `mock_provider` | `plan` | Fast, deterministic validation of resource config, feature toggles, and input validation. No credentials needed. |
| Acceptance tests | Real | `plan` | Plan-level verification against real AWS APIs. Validates computed attributes and provider-resolved values. Requires credentials. |
| Integration tests | Real | `apply` | End-to-end resource creation and destruction. Verifies functional behavior in AWS. Requires credentials. |

Unit tests MUST cover: secure defaults, full features, feature interactions, validation errors, and validation boundaries.

### 5.2 Validation Pipeline

Every module MUST pass before release:

| Check | Tool | Blocks Release |
|-------|------|:-:|
| Formatting | `terraform fmt -check` | Yes |
| Syntax | `terraform validate` | Yes |
| Tests | `terraform test` | Yes |
| Linting | `tflint` | Yes |
| Security scan | `trivy config .` — no Critical or High | Yes |
| Documentation | `terraform-docs` — README current | Yes |

Pre-commit hooks MUST enforce these checks.

### 5.3 Test Organization

```
tests/
  unit_basic.tftest.hcl         # Unit: secure defaults with minimal inputs (mock providers)
  unit_complete.tftest.hcl      # Unit: all features enabled (mock providers)
  unit_edge_cases.tftest.hcl    # Unit: feature toggle combinations (mock providers)
  unit_validation.tftest.hcl    # Unit: invalid inputs (expect_failures) + boundary-pass (mock providers)
  acceptance.tftest.hcl         # Acceptance: plan with real providers (requires credentials)
  integration.tftest.hcl        # Integration: apply with real providers (requires credentials)
```

Each test file maps to a category and scenario group in `design.md` Section 5.

---

## 6. Change Management

### 6.1 Git Workflow

- Direct commits to `main` PROHIBITED
- All changes MUST be made via feature branches
- Pull requests with human review REQUIRED for all merges
- MUST NOT commit secrets, credentials, or sensitive data
- Test values for examples managed via `*.tfvars` files, not hardcoded in module code

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
| Build+Test -> Validate | `terraform validate` passes. All implementation checklist items complete. |
| Validate -> Complete | All validation checks from Section 5.2 pass. |

---

## 7. Operational Standards

### 7.1 Cost Optimization

- Modules SHOULD expose variables for instance sizing, storage, and scaling
- Defaults SHOULD be cost-effective — consumers override for production
- Cost-impacting configuration choices SHOULD be documented
- Examples SHOULD use minimal resource sizes

### 7.2 Observability

- Modules SHOULD enable monitoring by default where applicable
- Tags MUST include `Name` and `ManagedBy = "terraform"` at minimum
- Modules SHOULD output critical resource identifiers for monitoring integration
- Logging resources SHOULD be created by default with opt-out variables

### 7.3 HCP Terraform

- Organization, project, and workspace MUST be validated before any registry or workspace operations
- Sandbox workspaces for testing use pattern: `sandbox_<module>_<example>`
- Ephemeral workspaces MUST be deleted after testing
- Feature branch MUST be pushed to remote before creating workspaces

---

## 8. Governance

### 8.1 Constitution Maintenance

- Platform team maintains this constitution in version control
- Major changes require security and governance team review
- Module developers MAY propose amendments via pull request
- Constitution version MUST be referenced in agent prompts

### 8.2 Exception Process

Deviations from this constitution require:

1. Documented requirement driving the exception
2. Alternative approach with risk assessment
3. Platform team approval
4. Exception documented in code and centralized exceptions register
5. Review during next policy update cycle

### 8.3 Audit and Compliance

- All module code — AI-generated or human-authored — passes through the same policy enforcement
- Periodic audits verify constitution compliance
- Non-compliant patterns trigger constitution updates or module remediation
- Metrics track module quality, test coverage, and security posture

### 8.4 Documentation

- Every module MUST include `README.md` auto-generated via `terraform-docs`
- Complex logic MUST include inline comments explaining rationale
- Resource configurations MUST be justified in comments where non-obvious
