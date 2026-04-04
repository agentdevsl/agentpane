---
name: "tf-module-design"
description: "Terraform module design. Produce a single design.md from clarified requirements and research findings. Merges specification, planning, and security baseline concerns into one artifact covering purpose & requirements, resource inventory, interface contract, security controls, test scenarios, and implementation checklist."
source: image
---
# Module Design Author

Produce a single `specs/{FEATURE}/design.md` from clarified requirements and research findings. This document is the SINGLE SOURCE OF TRUTH for the module. Every downstream agent reads only this file.

## Instructions

1. **Read Context**: Load `.foundations/memory/module-constitution.md` (for security defaults §1.2, file layout §2.1, naming §2.2, variable conventions §2.3, security §3, tags §3.3) and `.foundations/templates/module-design-template.md` (for the authoritative section structure and template rules).

2. **Parse Input**: Extract from `$ARGUMENTS`:
   - The FEATURE path (e.g., `specs/vpc/`)
   - Clarified requirements from Phase 1 (user-confirmed functional and non-functional requirements)

3. **Load Research**: Read all research files from `specs/{FEATURE}/research-*.md` via Glob. These contain MCP research results — provider documentation, AWS best practices, resource behavior, and registry patterns that MUST inform the design. Every resource selection in Section 2 must reference these findings.

4. **Design**: Populate ALL 7 sections of the design template. Start with a Table of Contents linking to all 7 sections. Each section has specific rules:

   ### Section 1 — Purpose & Requirements

   Describe WHAT this module creates and WHY it exists. Identify who consumes it and what problem it solves. Define the scope boundary (what is explicitly OUT of scope).
   - **NEVER include implementation details**: no resource types, no provider APIs, no internal wiring
   - Requirements must be testable and unambiguous
   - Success criteria must be measurable and technology-agnostic
   - Frame capabilities in terms of outcomes, not resources (e.g., "network traffic between tiers must be restricted" not "configure aws_security_group to allow port 5432")

   Include a **Requirements** subsection with:
   - **Functional requirements** — what the module must do, derived from Phase 1 clarification. Each requirement is a testable, technology-agnostic statement.
   - **Non-functional requirements** — constraints like compliance frameworks, performance targets, availability requirements, or operational constraints that bound the design.

   ### Section 2 — Resources & Architecture

   Define the architectural decisions and resource inventory, grounded in research findings.
   - **Architectural Decisions** come first — rationale before inventory. Use the format: `**{Decision title}**: {Choice}. *Rationale*: {Why}. *Source*: {provider doc ID, AWS documentation URL, or provider version}. *Rejected*: {Alternatives and why not}.`
   - **Resource Inventory table columns**: Resource Type | Logical Name | Conditional | Depends On | Key Configuration | Schema Notes
   - **Schema Notes column**: For each resource, note which nested blocks are set-typed vs list-typed in the provider schema (e.g., "rule is set", "transition is set"). This prevents `[0]` indexing errors in test assertions — set-typed blocks require `one()` instead. Use `--` if the resource has no notable nested block types.
   - Use `this` as the primary resource name for single-instance resources (constitution §2.2)
   - Use descriptive names for multiple resources of the same type (e.g., `public`, `private`)
   - **Every resource selection MUST reference research findings** — cite which research question/finding justified the choice
   - Provider version MUST be derived from research findings, not guessed — use `>=` constraints per constitution
   - **Key Configuration** in the Resource Inventory must include implementation-critical details discovered during research (required empty blocks, ordering dependencies, deprecated arguments, API quirks)
   - If a resource is unconditional (no toggle variable) and similar modules commonly make it optional, document why in Architectural Decisions
   - Follow `tf-architecture-patterns` for module composition, conditional creation, and policy patterns

   ### Section 3 — Interface Contract

   Define the module's public interface — inputs and outputs. This table is the SINGLE SOURCE OF TRUTH for the interface; it is not repeated anywhere else.
   - **Inputs table columns**: Variable | Type | Required | Default | Validation | Sensitive | Description
   - **Outputs table columns**: Output | Type | Conditional On | Description
   - Every user-facing input MUST include a validation rule (or `--` if none needed)
   - Sensitive variables (passwords, keys, tokens) MUST be marked `Yes` in the Sensitive column
   - Security-sensitive inputs MUST have secure defaults (e.g., `public_access = false`, `encryption_enabled = true`)
   - Include `create_*` boolean variables for conditional resource creation
   - Variable names use `snake_case` following constitution §2.2

   ### Section 4 — Security Controls

   Define security enforcement for the module. Every module MUST address the 6 security domains:
   - **Encryption at rest** — KMS, SSE, volume encryption. Default: enabled.
   - **Encryption in transit** — TLS, HTTPS-only, SSL certificates. Default: enforced.
   - **Public access** — Public IPs, public endpoints, S3 public access blocks. Default: denied.
   - **IAM least privilege** — Scoped policies, specific resource ARNs, no wildcards. Default: minimal permissions.
   - **Logging** — CloudTrail, VPC Flow Logs, access logs, CloudWatch. Default: enabled.
   - **Tagging** — Required tags per constitution §3.3.
   - **Security Controls table columns**: Control | Enforcement | Configurable? | Reference
   - Mark `N/A` where a domain does not apply (with justification)
   - Every control MUST have a CIS AWS Benchmark or AWS Well-Architected reference
   - If a control is hardcoded (not configurable), document WHY
   - If a control is configurable, the default MUST be the secure option
   - Security toggles expose features as variables with secure defaults — consumers opt OUT, not IN
   - Modules MUST NOT manage provider credentials — inherited from consumers
   - Sensitive variables and outputs MUST use `sensitive = true`

   ### Section 5 — Test Scenarios

   Define test scenarios that will drive TDD implementation. Five scenario groups are required:
   - **Secure Defaults** (basic) — Verify the module works with minimal inputs and security is enabled by default
   - **Full Features** (complete) — Verify all features enabled, all optional resources created, all outputs populated
   - **Feature Interactions** (edge cases) — Verify non-obvious toggle combinations: features that gate other resources, disabled-feature suppression, features without their typical companions, default/merge precedence. Aim for 3-6 sub-scenarios covering the meaningful combinations from the resource inventory's Conditional column.
   - **Validation Errors** (reject) — Verify invalid inputs are rejected with clear error messages
   - **Validation Boundaries** (accept) — Verify boundary-pass values are accepted: minimum valid, maximum valid, and edge values for each validation rule. Confirms validations do not over-reject.
   - **Start with a Test Strategy sub-section** specifying: (1) tests run against the root module directly (no `module {}` blocks), (2) mock provider strategy (`mock_provider` blocks), (3) whether `mock_data` blocks are needed for data sources
   - Each scenario specifies: Purpose, Example directory, Command (`plan` for all plan-only tests), Inputs (HCL), and Assertions
   - **Every assertion maps 1:1 to a `.tftest.hcl` assert block** — no compound assertions
   - **Every assertion includes the HCL access path** — e.g., `aws_s3_bucket.this.bucket == "my-bucket"` or `one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"`. Use the Schema Notes column from Section 2 to determine when `one()` is needed for set-typed blocks.
   - **Flag plan-time unknowns**: Assertions on computed or provider-resolved attributes are untestable with `command = plan` and mock providers. This includes: (1) provider-generated values like ARNs, endpoints, and IDs, and (2) cross-resource reference attributes that mock providers cannot resolve (e.g., `.bucket` on `aws_s3_bucket_policy`, `.id` or `.arn` read from a dependent resource). If an attribute's value comes from another resource's computed output, it will be unknown with mocks. Mark these with `[plan-unknown]` so the test writer can substitute resource-existence checks.
   - Use `command = plan` for all plan-only tests (no cloud access needed)
   - Include security assertions from line 1: encryption enabled, public access blocked, TLS enforced, least-privilege policies
   - Validation error scenarios use `expect_failures` to verify rejection of bad inputs

   ### Section 6 — Implementation Checklist

   Define 4-8 coarse-grained implementation items, ordered by dependency.
   - Each item = one implementation pass, completable in one agent turn
   - Standard ordering: Scaffold -> Security core -> Feature set -> Examples -> Tests -> Polish
   - NO line references between sections (template rule)
   - NO fine-grained task breakdowns — keep items at the logical-unit level

   ### Section 7 — Open Questions

   List any unresolved items marked `[DEFERRED]` with context. This section SHOULD be empty if Phase 1 clarification was thorough.

5. **Validate**: Before writing the file, check completeness:
   - Table of Contents links to all 7 sections
   - Every variable in §3 has Type + Description filled
   - Every resource in §2 has a Logical Name and Key Configuration
   - Architectural Decisions appear before Resource Inventory in §2
   - Every security control in §4 has a CIS or Well-Architected reference (or explicit N/A justification)
   - Every security control row in §4 maps to at least one specific assertion in §5 (not just resource existence -- assert the enforced configuration value)
   - §5 has all 5 scenario groups: secure defaults, full features, feature interactions, validation errors, validation boundaries
   - Every test scenario in §5 has >= 2 assertions
   - Feature interactions cover toggle combinations from §2 resource Conditional column
   - Validation boundaries include boundary-pass cases for each validation rule in §3
   - Implementation checklist in §6 has 4-8 items
   - No section references another section by line number (template rule)
   - Variable names appear exactly once — in §3 Interface Contract
   - Resource names appear exactly once — in §2 Resource Inventory

6. **Write**: Output the completed design to `specs/{FEATURE}/design.md`. Create the directory if it does not exist.

## Constraints

### Purpose & Requirements (Section 1)

- Describe WHAT and WHY — never HOW
- No resource types, no provider APIs, no internal wiring
- All requirements must be testable and unambiguous
- Functional requirements are technology-agnostic outcomes from Phase 1 clarification
- Non-functional requirements are constraints that bound the design (compliance, performance, availability)
- Maximum 3 `[NEEDS CLARIFICATION]` markers — make informed guesses and document assumptions

### Resources & Architecture (Section 2)

- Architectural Decisions come before Resource Inventory — rationale before inventory
- Every resource selection must reference research findings (evidence-based)
- Provider version derived from research, not guessed
- Follow constitution §2.1 for standard module structure
- Document rationale for all architectural decisions with alternatives considered

### Interface Contract (Section 3)

- Variables must include validation rules for user-facing inputs
- Sensitive variables marked with `Sensitive = Yes`
- Security-sensitive inputs default to the secure option
- This table is the single source of truth — not duplicated elsewhere

### Security Controls (Section 4)

- Every module must address: encryption at rest, encryption in transit, public access, IAM least privilege, logging, and tagging
- Mark N/A where not applicable with justification
- Reference CIS AWS Benchmark or Well-Architected for each control
- Hardcoded controls must explain WHY they are not configurable
- Configurable controls must default to the secure option
- No credentials in modules — provider auth is the consumer's responsibility

### Test Scenarios (Section 5)

- Start with a Test Strategy sub-section (root module testing, mock provider config, mock_data needs)
- Use `command = plan` for all plan-only tests
- Map 1:1 from design assertion to `.tftest.hcl` assert block — include the HCL access path in each assertion
- Use `one()` for set-typed nested blocks (check Schema Notes in Section 2)
- Mark computed or provider-resolved attribute assertions with `[plan-unknown]` (includes ARNs, endpoints, IDs, and cross-resource references like `.bucket` or `.id` on dependent resources)
- Include security assertions from line 1
- Five scenario groups required: secure defaults, full features, feature interactions, validation errors, validation boundaries

### Implementation Checklist (Section 6)

- Coarse-grained: 4-8 items only
- Ordered by dependency
- No line references between sections (template rule)
- Each item completable in one agent turn
- Each item lists which files it creates or modifies — no overlap between items

### Cross-Cutting

- Cross-reference constitution §2.1 (file layout), §3 (security), §3.3 (tags) during design
- If research findings contradict a specific constitution rule, add a `[CONSTITUTION DEVIATION]` entry in §7 with: the rule number, what the research found, and why the deviation is justified
- Maximum 3 `[NEEDS CLARIFICATION]` markers total — prefer informed assumptions with documented rationale
- Naming consistency: resource and variable names must be canonical throughout the document

## Risk Rating Quick Reference

Use this when assessing severity of security design choices:

| Rating            | Meaning               | Example                                                                       |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- |
| **Critical (P0)** | Block deployment      | Hardcoded credentials, public S3 with sensitive data, IAM `*:*`               |
| **High (P1)**     | Fix before production | Unencrypted storage, overly permissive security groups, missing audit logging |
| **Medium (P2)**   | Fix in current sprint | Missing VPC Flow Logs, no MFA, weak password policy                           |
| **Low (P3)**      | Add to backlog        | Missing resource tags, outdated AMI                                           |

## Security Domain Checklist

Before finalizing §4, verify each domain is addressed:

1. **IAM**: Least privilege, no wildcards, specific resource ARNs, scoped policies
2. **Data Protection**: Encryption at rest (KMS/SSE) + in transit (TLS/HTTPS), no hardcoded credentials, sensitive marking
3. **Network Security**: Private subnets default, security groups deny-all default, no 0.0.0.0/0 ingress
4. **Logging & Monitoring**: CloudTrail, VPC Flow Logs, access logs, CloudWatch alerting
5. **Resilience**: Backup strategy, multi-AZ where applicable, deletion protection
6. **Compliance**: Tagging per constitution §3.3, audit trails, data residency awareness

## Examples

**Good** (Section 3 excerpt — secure defaults, validation rules, no duplication):

```markdown
| Variable               | Type     | Required | Default     | Validation                     | Sensitive | Description                      |
| ---------------------- | -------- | -------- | ----------- | ------------------------------ | --------- | -------------------------------- |
| `bucket_name`          | `string` | Yes      | --          | `length >= 3 && length <= 63`  | No        | Name of the S3 bucket            |
| `enable_versioning`    | `bool`   | No       | `false`     | --                             | No        | Enable object versioning         |
| `encryption_algorithm` | `string` | No       | `"aws:kms"` | `one of ["aws:kms", "AES256"]` | No        | Server-side encryption algorithm |
```

**Bad** (vague defaults, missing validation, duplicates resource details from Section 2):

```markdown
| Variable      | Type     | Required | Default | Description                                                       |
| ------------- | -------- | -------- | ------- | ----------------------------------------------------------------- |
| `bucket_name` | `string` | Yes      |         | Name                                                              |
| `encryption`  | `string` | No       |         | Encryption for aws_s3_bucket_server_side_encryption_configuration |
```

Missing: secure default for encryption, validation rule, Sensitive column. Leaks resource type into interface contract.

## Output

Single file: `specs/{FEATURE}/design.md`

## Context

$ARGUMENTS
