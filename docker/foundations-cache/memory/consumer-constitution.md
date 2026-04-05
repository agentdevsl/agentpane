# Terraform Consumer Provisioning Constitution

**Organization**: [Your Organization Name]
**Version**: 1.0.0
**Effective Date**: February 2026
**Purpose**: Non-negotiable principles for composing infrastructure from private registry modules
**Authority**: This document governs what correct consumer code looks like. Workflow mechanics live in orchestrator skills. Agent behavior lives in AGENTS.md. If a rule exists here, it is not duplicated elsewhere.

---

## 1. Core Principles

### 1.1 Module-First Composition

Consumers MUST compose infrastructure exclusively from private registry modules — NOT author raw resources.

- ALL infrastructure MUST be provisioned via private registry modules: `source = "app.terraform.io/<org>/<name>/<provider>"`
- Raw `resource` blocks are PROHIBITED except for glue resources (`random_id`, `random_string`, `null_resource`, `terraform_data`, `time_sleep`)
- Module versions MUST be pinned with `version = "~> X.Y.Z"` constraints
- Module selection MUST be justified by research findings — never assumed
- Consumers do NOT write `.tftest.hcl` files — validation is via `terraform validate` and sandbox deployment

### 1.2 Security-First Configuration

Consumer code MUST honour module secure defaults and never weaken them without documented justification.

- Module secure defaults MUST NOT be overridden to weaken security (e.g., setting `encryption_enabled = false`)
- Security-weakening overrides require a `[SECURITY OVERRIDE]` comment with justification
- Provider `default_tags` MUST propagate standard tags to all resources
- IAM and network configuration MUST follow least-privilege principles
- Secrets MUST be sourced from Terraform variables marked `sensitive = true` or HCP Terraform variable sets — never hardcoded

### 1.3 Workspace-Aware Deployment

Consumer code MUST be structured for HCP Terraform workspace execution.

- Backend configuration MUST use `cloud {}` block for HCP Terraform
- Dynamic provider credentials MUST be used — never static AWS credentials
- Workspace variables MUST be documented in the design document
- Environment separation MUST use workspace-per-environment or variable-driven patterns
- State MUST NOT be committed to version control

### 1.4 Single Design Document

All planning produces one file: `specs/{FEATURE}/consumer-design.md`.

- Module selections, wiring decisions, and workspace configuration each appear exactly once
- No separate specification, plan, contract, data model, or task files
- The design document is the sole source of truth for the consumer deployment

---

## 2. Code Standards

### 2.1 File Organization

Consumer root modules MUST follow this structure:

```
/
├── main.tf              # Module calls and glue resources
├── variables.tf         # Input variable declarations
├── outputs.tf           # Output value declarations
├── locals.tf            # Local value computations (wiring, naming)
├── versions.tf          # Terraform and provider version constraints
├── providers.tf         # Provider configuration (region, default_tags, assume_role)
├── backend.tf           # HCP Terraform cloud {} block
├── data.tf              # Data source definitions (if needed)
├── README.md            # Deployment documentation
└── terraform.auto.tfvars.example  # Example variable values
```

Rules:

- Provider configuration MUST be in `providers.tf` — consumers ARE where providers are configured
- `backend.tf` MUST contain the `cloud {}` block for HCP Terraform
- Module calls SHOULD be grouped logically in `main.tf` (networking, compute, data, monitoring)
- No single file MAY exceed 500 lines — split large configurations logically
- Variable files for environment overrides use `*.tfvars` naming

### 2.2 Naming

- Module calls: descriptive names matching their purpose (`module "vpc"`, `module "eks_cluster"`, `module "rds_primary"`)
- Variables: `snake_case` with descriptive names
- Outputs: `snake_case`, mirroring module output names where possible
- Locals: used for computed wiring values (e.g., `local.subnet_ids = module.vpc.private_subnet_ids`)
- Names MUST NOT contain sensitive information (account IDs, secrets, PII)
- Resource naming patterns: `{project}-{environment}-{component}` via locals

### 2.3 Variables

Every variable MUST include:

- `description` — purpose and valid values
- `type` — explicit constraint, never implicit `any`
- `sensitive = true` — for security-sensitive values (passwords, tokens, API keys)

Variables SHOULD include:

- `validation` blocks for business logic constraints
- Sensible defaults where possible — minimize required inputs
- Environment-specific values SHOULD come from `*.tfvars` files or HCP Terraform variable sets

### 2.4 Outputs

- Outputs exposing secrets MUST be marked `sensitive = true`
- Outputs MUST surface key identifiers needed by downstream consumers or monitoring
- All outputs MUST have `description` for documentation
- Outputs SHOULD mirror the most-used module outputs (VPC ID, cluster endpoint, database endpoint)

### 2.5 Module Wiring Patterns

- Module outputs feeding into other module inputs MUST use direct references: `module.vpc.private_subnet_ids`
- Complex transformations SHOULD use `locals {}` blocks for clarity
- Type mismatches between module outputs and inputs MUST be resolved explicitly (e.g., `tolist()`, `toset()`)
- Circular dependencies between modules are PROHIBITED — restructure the composition
- Module `depends_on` SHOULD be avoided; prefer explicit data flow via outputs/inputs

### 2.6 Code Style

- Follow the [HashiCorp Style Guide](https://developer.hashicorp.com/terraform/language/style)
- Module calls: source first, version second, then required inputs, optional inputs, meta-arguments
- Auto-format with `terraform fmt`
- Complex wiring logic MUST include inline comments explaining the data flow
- All variables and outputs MUST have descriptions

---

## 3. Security and Compliance

### 3.1 Credentials and Authentication

- Provider authentication MUST use HCP Terraform dynamic provider credentials
- MUST NOT define static credential variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or equivalent)
- Cross-account access MUST use `assume_role` in provider configuration
- Variables accepting secrets MUST be marked `sensitive = true`
- Secrets MUST be managed via HCP Terraform variable sets or workspace variables marked sensitive

### 3.2 Module Security Configuration

These rules apply to all module configurations. Consumers MUST NOT weaken module secure defaults.

| Control | Requirement |
|---------|-------------|
| Encryption at rest | MUST NOT disable module encryption defaults. If module defaults to encryption enabled, consumer MUST NOT set `encryption_enabled = false`. |
| Encryption in transit | MUST NOT disable TLS/HTTPS enforcement provided by modules. |
| Public access | MUST NOT enable public access unless explicitly required and documented with `[SECURITY OVERRIDE]`. |
| Security Groups | MUST configure module security group inputs with least-privilege rules. No `0.0.0.0/0` ingress unless justified. |
| IAM roles | MUST pass specific resource ARNs to module IAM inputs. No wildcard permissions. |
| Logging | MUST enable module logging features (access logs, flow logs, audit trails) where available. |

### 3.3 Tagging

- Provider `default_tags` block MUST include: `ManagedBy = "terraform"`, `Environment`, `Project`, `Owner`
- Module-specific tags SHOULD be passed via module `tags` variable
- Tags MUST NOT contain sensitive information
- Cost allocation tags SHOULD be included per organizational policy

---

## 4. Version and Dependency Management

### 4.1 Provider Constraints

```hcl
terraform {
  required_version = ">= 1.14"

  cloud {
    organization = "<org>"
    workspaces {
      name = "<workspace>"
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

- Consumers MUST declare `required_version` with a minimum Terraform version
- Provider versions MUST use `~>` in consumers (pessimistic constraint) for stability
- Module versions MUST use `~>` for minor version flexibility: `version = "~> 1.2"`
- MUST NOT use `latest` or unconstrained versions

### 4.2 State Management

- Backend MUST use HCP Terraform `cloud {}` block
- State MUST NOT be committed to version control
- State locking is handled by HCP Terraform — no additional configuration needed
- Workspace-specific state isolation MUST be maintained

### 4.3 Module Versioning

- Module sources MUST reference the private registry: `app.terraform.io/<org>/<name>/<provider>`
- Version constraints MUST use pessimistic operator: `version = "~> X.Y"`
- Major version upgrades require design document update and review
- CHANGELOG of consumed modules SHOULD be reviewed before version bumps

---

## 5. Testing and Validation

### 5.1 Validation Pipeline

Consumer code does NOT use `.tftest.hcl` files. Validation is via tooling and sandbox deployment.

| Check | Tool | Blocks Deployment |
|-------|------|:-:|
| Formatting | `terraform fmt -check` | Yes |
| Syntax | `terraform validate` | Yes |
| Linting | `tflint` | Yes |
| Security scan | `trivy config .` — no Critical or High | Yes |
| Sandbox deploy | HCP Terraform plan + apply in sandbox workspace | Yes |
| Destroy clean | Sandbox workspace destroy succeeds | Yes |

### 5.2 Sandbox Deployment

- Every consumer deployment MUST be validated in a sandbox workspace before production
- Sandbox workspace naming: `sandbox-{project}-{feature}`
- Sandbox MUST use the same provider configuration as production (region, credentials pattern)
- Sandbox resources MUST be destroyed after successful validation
- Deploy failures block production deployment

### 5.3 Wiring Validation

- `terraform validate` catches type mismatches between module outputs and inputs
- `terraform plan` in sandbox verifies module compatibility and resource creation
- Module output consumption MUST be verified — unused module outputs should be reviewed for necessity

---

## 6. Change Management

### 6.1 Git Workflow

- Direct commits to `main` PROHIBITED
- All changes MUST be made via feature branches
- Pull requests with human review REQUIRED for all merges
- MUST NOT commit secrets, credentials, or sensitive data
- Environment-specific values managed via HCP Terraform variable sets, not committed files

### 6.2 Design Approval

Issue-driven workflow MUST pause between Design and Build phases for human review of the design document.

- Gate signal: "approved" or "proceed" comment on the tracking issue
- Autonomous mode: MAY skip approval only if no CRITICAL security findings exist in the design

### 6.3 Quality Gates Between Phases

All four workflow phases are mandatory and sequential. Between phases:

| Gate | Condition |
|------|-----------|
| Understand -> Design | Requirements clear. No unresolved `[NEEDS CLARIFICATION]` markers. |
| Design -> Build | Design document approved. No unresolved CRITICAL findings. |
| Build -> Validate | `terraform validate` passes. All implementation checklist items complete. |
| Validate -> Complete | Sandbox deploy succeeds. Security review passes. Quality score >= 7.0. |

---

## 7. Operational Standards

### 7.1 Cost Optimization

- Module inputs for instance sizing, storage, and scaling SHOULD use cost-effective defaults
- Cost-impacting configuration choices MUST be documented in the design
- Sandbox deployments SHOULD use minimal resource sizes
- HCP Terraform cost estimation SHOULD be reviewed during sandbox plan

### 7.2 Observability

- Monitoring modules SHOULD be included in the composition (CloudWatch, alarms, dashboards)
- Provider `default_tags` MUST include tags for monitoring and cost allocation
- Module outputs for endpoints and identifiers MUST be surfaced for integration

### 7.3 HCP Terraform

- Organization, project, and workspace MUST be validated before any deployment
- Dynamic provider credentials MUST be configured at the workspace level
- Variable sets MUST be used for shared configuration (provider credentials, common tags)
- Run triggers MAY be used for cross-workspace dependencies
- Sentinel policies MAY enforce organizational compliance at the workspace level

---

## 8. Governance

### 8.1 Constitution Maintenance

- Platform team maintains this constitution in version control
- Major changes require security and governance team review
- Infrastructure developers MAY propose amendments via pull request
- Constitution version MUST be referenced in agent prompts

### 8.2 Exception Process

Deviations from this constitution require:

1. Documented requirement driving the exception
2. Alternative approach with risk assessment
3. Platform team approval
4. Exception documented in code with `[CONSTITUTION DEVIATION]` comment and centralized exceptions register
5. Review during next policy update cycle

### 8.3 Audit and Compliance

- All consumer code — AI-generated or human-authored — passes through the same policy enforcement
- Periodic audits verify constitution compliance
- Non-compliant patterns trigger constitution updates or code remediation
- Metrics track deployment quality, security posture, and module version currency

### 8.4 Documentation

- Every consumer deployment MUST include `README.md` with deployment instructions
- Complex wiring logic MUST include inline comments explaining data flow
- Module selection rationale MUST be documented in the design document
- Security overrides MUST be justified in code comments
