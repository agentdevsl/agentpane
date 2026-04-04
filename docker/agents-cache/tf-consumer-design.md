---
name: "tf-consumer-design"
description: "Produce a single consumer-design.md from clarified requirements and research findings. Covers module selection, wiring architecture, security controls, and implementation checklist for composing infrastructure from private registry modules."
source: image
---
# Consumer Design Author

Produce a single `specs/{FEATURE}/consumer-design.md` from clarified requirements and research findings. This document is the SINGLE SOURCE OF TRUTH for the consumer deployment. Every downstream agent reads only this file.

## Instructions

1. **Read Context**: Load `.foundations/memory/consumer-constitution.md` (for module-first rules §1.1, security §1.2, workspace §1.3, file layout §2.1, naming §2.2, variable conventions §2.3, credentials §3.1, tags §3.3) and `.foundations/templates/consumer-design-template.md` (for the authoritative section structure and template rules).

2. **Parse Input**: Extract from `$ARGUMENTS`:
   - The FEATURE path (e.g., `specs/order-service/`)
   - Clarified requirements from Phase 1 (user-confirmed functional and non-functional requirements)

3. **Load Research**: Read all research files from `specs/{FEATURE}/research-*.md` via Glob. These contain MCP research results — private registry module availability, module interfaces, wiring patterns, and AWS architecture guidance that MUST inform the design. Every module selection in Section 2 must reference these findings.

4. **Design**: Populate ALL 6 sections of the design template. Start with a Table of Contents linking to all 6 sections. Each section has specific rules:

   ### Section 1 — Purpose & Requirements

   Describe WHAT this deployment provisions and WHY it exists. Identify the application/service it supports and what problem it solves. Define the scope boundary (what is explicitly OUT of scope).
   - **NEVER include implementation details**: no module sources, no provider APIs, no internal wiring
   - Requirements must be testable and unambiguous
   - Frame capabilities in terms of outcomes, not modules (e.g., "application requires isolated network with private compute" not "use terraform-aws-vpc module")

   Include a **Requirements** subsection with:
   - **Functional requirements** — what the deployment must provision, derived from Phase 1 clarification
   - **Non-functional requirements** — constraints like compliance, performance, availability, cost

   ### Section 2 — Module Selection & Architecture

   Define the architectural decisions, module inventory, glue resources, and workspace configuration.
   - **Architectural Decisions** come first — rationale before inventory. Use the format: `**{Decision title}**: {Choice}. *Rationale*: {Why, citing research findings}. *Rejected*: {Alternatives and why not}.`
   - **Module Inventory table columns**: Module | Registry Source | Version | Purpose | Conditional | Key Inputs | Key Outputs
   - **ALL modules MUST come from the private registry**: `app.terraform.io/<org>/<name>/<provider>`
   - **Every module selection MUST reference research findings** — cite which research question/finding justified the choice
   - Module versions MUST use pessimistic constraint: `~> X.Y`
   - **Glue Resources table**: Only `random_id`, `random_string`, `null_resource`, `terraform_data`, `time_sleep` — NO raw infrastructure resources
   - **Workspace Configuration table**: Organization, workspace, execution mode, variable sets
   - Follow `tf-architecture-patterns` for module composition and project structure patterns

   ### Section 3 — Module Wiring

   Define how modules connect to each other and the deployment's public interface.
   - **Wiring Diagram**: Text-based flow showing module output-to-input connections
   - **Wiring Table columns**: Source Module | Output | Target Module | Input | Type | Transformation
   - Every module output consumed by another module MUST appear in the wiring table
   - Type mismatches MUST note the transformation needed (e.g., `tolist()`, `toset()`)
   - **Provider Configuration**: Full provider block with `default_tags` per constitution §3.3
   - **Variables table columns**: Variable | Type | Required | Default | Validation | Sensitive | Description
   - **Outputs table columns**: Output | Type | Source | Description
   - This section is the SINGLE SOURCE OF TRUTH for the interface — not repeated anywhere else

   ### Section 4 — Security Controls

   Define security enforcement across the module composition. Consumer security is about HONOURING module defaults, not reimplementing controls.
   - **Security Controls table columns**: Control | Enforcement | Module Config | Reference
   - Address the 6 security domains: encryption at rest, encryption in transit, public access, IAM least privilege, logging, tagging
   - Document WHICH MODULE enforces each control and HOW
   - If a module secure default is being overridden, mark with `[SECURITY OVERRIDE]` and justification
   - Mark `N/A` where a domain does not apply (with justification)
   - Every control MUST have a CIS AWS Benchmark or AWS Well-Architected reference
   - Provider `default_tags` MUST include `ManagedBy`, `Environment`, `Project`, `Owner`

   ### Section 5 — Implementation Checklist

   Define 4-8 coarse-grained implementation items, ordered by dependency.
   - Each item = one implementation pass, completable in one agent turn
   - Standard ordering: Scaffold -> Core modules -> Supporting modules -> Wiring -> Polish
   - NO line references between sections (template rule)
   - NO fine-grained task breakdowns — keep items at the logical-unit level
   - Each item lists which files it creates or modifies — no overlap between items

   ### Section 6 — Open Questions

   List any unresolved items marked `[DEFERRED]` with context. This section SHOULD be empty if Phase 1 clarification was thorough.

5. **Self-Validate**: Before writing the file, run these quality checks:

   #### Requirement Quality Validation

   - Every functional requirement in §1 maps to at least one module in §2
   - No requirement is ambiguous or untestable
   - Scope boundary is clearly defined

   #### Specification Consistency

   - Table of Contents links to all 6 sections
   - Every module in §2 has Registry Source and Version filled
   - Every module output consumed downstream appears in §3 Wiring Table
   - Wiring diagram matches wiring table (no orphaned connections)
   - Every variable in §3 has Type + Description filled
   - Every security control in §4 has a CIS or Well-Architected reference (or explicit N/A justification)
   - Provider configuration in §3 includes `default_tags` per constitution
   - Implementation checklist in §5 has 4-8 items
   - No section references another section by line number (template rule)
   - Module names appear exactly once — in Module Inventory (§2)
   - Variable names appear exactly once — in Module Wiring (§3)
   - No raw infrastructure `resource` blocks (only glue resources allowed)

   #### Cross-Reference Validation

   - Every module listed in §2 is referenced in at least one wiring connection in §3
   - Every security control in §4 references a specific module from §2
   - Implementation checklist items in §5 cover all modules from §2

6. **Write**: Output the completed design to `specs/{FEATURE}/consumer-design.md`. Create the directory if it does not exist.

## Constraints

### Purpose & Requirements (Section 1)

- Describe WHAT and WHY — never HOW
- No module names, no registry sources, no internal wiring
- All requirements must be testable and unambiguous
- Maximum 3 `[NEEDS CLARIFICATION]` markers — make informed guesses and document assumptions

### Module Selection & Architecture (Section 2)

- ALL modules from private registry — no public registry, no raw resources (except glue)
- Every module selection must reference research findings (evidence-based)
- Module versions use pessimistic constraint (`~>`)
- Document rationale for all architectural decisions with alternatives considered
- Glue resources limited to: `random_id`, `random_string`, `null_resource`, `terraform_data`, `time_sleep`

### Module Wiring (Section 3)

- Wiring diagram must match wiring table — no orphaned connections
- Type mismatches must note transformations
- Variables must include validation rules for user-facing inputs
- Sensitive variables marked with `Sensitive = Yes`
- This section is the single source of truth for the interface — not duplicated
- leverage implicit dependency ordering from wiring connections — no explicit ordering references where possible

### Security Controls (Section 4)

- Consumer security = honouring module defaults, not reimplementing
- Every control references which module enforces it
- Security overrides require `[SECURITY OVERRIDE]` with justification
- Provider `default_tags` must include `ManagedBy`, `Environment`, `Project`, `Owner`
- Reference CIS AWS Benchmark or Well-Architected for each control

### Implementation Checklist (Section 5)

- Coarse-grained: 4-8 items only
- Ordered by dependency
- No line references between sections (template rule)
- Each item completable in one agent turn
- Each item lists which files it creates or modifies — no overlap between items

### Cross-Cutting

- Cross-reference constitution §2.1 (file layout), §3 (security), §3.3 (tags) during design
- If research findings contradict a specific constitution rule, add a `[CONSTITUTION DEVIATION]` entry in §6 with: the rule number, what the research found, and why the deviation is justified
- Maximum 3 `[NEEDS CLARIFICATION]` markers total — prefer informed assumptions with documented rationale
- Naming consistency: module and variable names must be canonical throughout the document

## Risk Rating Quick Reference

Use this when assessing severity of security design choices:

| Rating            | Meaning               | Example                                                                                    |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| **Critical (P0)** | Block deployment      | Hardcoded credentials, public database, disabled encryption, IAM `*:*`                     |
| **High (P1)**     | Fix before production | Module secure default overridden, overly permissive security groups, missing audit logging |
| **Medium (P2)**   | Fix in current sprint | Missing VPC Flow Logs, no alarm configuration, weak tagging                                |
| **Low (P3)**      | Add to backlog        | Missing resource tags, suboptimal instance sizing                                          |

## Security Domain Checklist

Before finalizing §4, verify each domain is addressed:

1. **IAM**: Dynamic credentials, assume_role for cross-account, no static keys, least-privilege module config
2. **Data Protection**: Module encryption defaults honoured, sensitive variables marked, no hardcoded secrets
3. **Network Security**: Private subnets for compute, security groups via module inputs, no 0.0.0.0/0 unless justified
4. **Logging & Monitoring**: Module logging features enabled, CloudWatch/alarms configured, VPC Flow Logs
5. **Resilience**: Multi-AZ via module config, backup features enabled, deletion protection
6. **Compliance**: Provider default_tags, module tags, audit trails, data residency via region config

## Output

Single file: `specs/{FEATURE}/consumer-design.md`

## Context

$ARGUMENTS
