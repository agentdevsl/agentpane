# Consumer Design: {project-name}

**Branch**: feat/{name}
**Date**: {YYYY-MM-DD}
**Status**: Draft | Approved | Implementing | Complete
**Provider**: {provider} ~> {version}
**Terraform**: >= {version}
**HCP Terraform Org**: {organization}

---

## Table of Contents

1. [Purpose & Requirements](#1-purpose--requirements)
2. [Module Selection & Architecture](#2-module-selection--architecture)
3. [Module Wiring](#3-module-wiring)
4. [Security Controls](#4-security-controls)
5. [Implementation Checklist](#5-implementation-checklist)
6. [Open Questions](#6-open-questions)

---

## 1. Purpose & Requirements

{One paragraph. What infrastructure this deployment provisions, who consumes it,
what application or service it supports. No implementation details.}

**Scope boundary**: {What is explicitly OUT of scope -- prevents scope creep.}

### Requirements

**Functional requirements** -- what the deployment must provision (from Phase 1 clarification):

- {Testable, technology-agnostic statement of required capability}
- ...

**Non-functional requirements** -- constraints like compliance, performance, availability, cost:

- {Constraint or quality attribute that bounds the design}
- ...

{Requirements bridge Purpose and Architecture. They are testable and unambiguous.
Frame capabilities in terms of outcomes, not modules.}

---

## 2. Module Selection & Architecture

### Architectural Decisions

{Each decision as a paragraph with this structure:}

**{Decision title}**: {What was chosen}.
*Rationale*: {Why, with research citation if applicable}.
*Rejected*: {What was considered and why it was rejected}.

### Module Inventory

| Module | Registry Source | Version | Purpose | Conditional | Key Inputs | Key Outputs |
|--------|---------------|---------|---------|-------------|------------|-------------|
| {name} | app.terraform.io/{org}/{name}/{provider} | ~> {X.Y} | {what it provisions} | {variable or "always"} | {critical inputs} | {outputs consumed downstream} |

### Glue Resources

| Resource Type | Logical Name | Purpose | Depends On |
|---------------|-------------|---------|------------|
| {random_id/null_resource/etc} | {name} | {why this glue is needed} | {module.name} |

{Use `--` if no glue resources are needed.}

### Workspace Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Organization | {org} | HCP Terraform organization |
| Workspace | {name} | Target workspace |
| Execution Mode | Remote | HCP Terraform managed |
| Terraform Version | >= {version} | Pinned in workspace |
| Variable Sets | {names} | Shared credentials, tags |
| VCS Connection | {repo/branch} | Optional — manual trigger if not set |

---

## 3. Module Wiring

### Wiring Diagram

{Text-based flow showing how module outputs connect to module inputs:}

```
module.vpc.private_subnet_ids ──→ module.eks.subnet_ids
module.vpc.vpc_id             ──→ module.rds.vpc_id
module.eks.cluster_sg_id      ──→ module.rds.allowed_security_groups
```

### Wiring Table

| Source Module | Output | Target Module | Input | Type | Transformation |
|--------------|--------|--------------|-------|------|----------------|
| {source} | {output_name} | {target} | {input_name} | {type} | {direct / tolist() / lookup() / --} |

### Provider Configuration

```hcl
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }

  # Dynamic credentials via HCP Terraform
  # assume_role { role_arn = var.deploy_role_arn }  # If cross-account
}
```

### Variables

| Variable | Type | Required | Default | Validation | Sensitive | Description |
|----------|------|----------|---------|------------|-----------|-------------|
| {name} | {type} | {Yes/No} | {value or --} | {rule or --} | {Yes/No} | {description} |

{This table is the SINGLE SOURCE OF TRUTH for the deployment's input interface.
It is not repeated anywhere else in any artifact. Includes both deployment-level
variables and any module input overrides exposed to the consumer.}

### Outputs

| Output | Type | Source | Description |
|--------|------|--------|-------------|
| {name} | {type} | module.{name}.{output} | {description} |

---

## 4. Security Controls

| Control | Enforcement | Module Config | Reference |
|---------|-------------|---------------|-----------|
| Encryption at rest | {how -- module default or explicit config} | {module.name: input = value} | {CIS/WA control} |
| Encryption in transit | {how} | {module config} | {CIS/WA control} |
| Public access | {how} | {module config} | {CIS/WA control} |
| IAM least privilege | {how} | {module config} | {CIS/WA control} |
| Logging | {how} | {module config} | {CIS/WA control} |
| Tagging | {how -- provider default_tags + module tags} | {provider + modules} | {CIS/WA control} |

{Rules:

- For each control, document which module enforces it and how.
- If a module secure default is being overridden, add `[SECURITY OVERRIDE]` with justification.
- Mark N/A where a domain does not apply, with justification.
- Reference column must cite a CIS AWS Benchmark or AWS Well-Architected control.
- Consumer security is about HONOURING module defaults, not reimplementing controls.}

---

## 5. Implementation Checklist

- [ ] **A: Scaffold** -- Create file structure: versions.tf (terraform + cloud block + required_providers), providers.tf (provider config with default_tags), variables.tf (all variables from Section 3), outputs.tf (all outputs), backend.tf (cloud block), locals.tf (naming, wiring computations)
- [ ] **B: Core modules** -- {primary module calls in main.tf with required inputs wired}
- [ ] **C: Supporting modules** -- {secondary module calls, monitoring, logging modules}
- [ ] **D: Wiring** -- {connect module outputs to inputs per Section 3 wiring table, verify data flow}
- [ ] **E: Polish** -- README, formatting, validation, security scan, example tfvars

{Keep this to 4-8 items. Each item = one implementation pass.
NOT a fine-grained task breakdown. Each item should be completable in one agent turn.
Each item must have clear scope boundaries -- list which files it creates/modifies.
Items must not overlap: if A creates a file, B must not also create that file.}

---

## 6. Open Questions

{Any deferred decisions marked [DEFERRED] with context.
Empty section if all questions resolved during clarification.}

---

## Template Rules

1. No section may reference another section by line number
2. Variable names appear exactly once -- in Module Wiring (Section 3)
3. Module names appear exactly once -- in Module Inventory (Section 2)
4. Implementation checklist items are coarse-grained -- one per logical unit with explicit file scope
5. Every module selection must be justified by research findings
6. Wiring table must account for every module output consumed by another module
