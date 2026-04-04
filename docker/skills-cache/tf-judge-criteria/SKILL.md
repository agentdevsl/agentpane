---
name: "tf-judge-criteria"
description: "Scoring rubrics, severity classification, evaluation methodology, and iterative refinement protocol for Terraform code quality assessment."
source: image
---
# Terraform Code Quality Evaluation Criteria

## Core Principles

1. **Evidence-Based**: All judgments grounded in observable evidence (file:line, code quotes)
2. **Actionable**: Every issue includes concrete remediation with before/after examples
3. **Calibrated**: Use full 1-10 scale, consistent and comparable, +/-0.5 variance on re-evaluation
4. **Constitution Authority**: MUST violations = CRITICAL, SHOULD = HIGH, MAY = LOW

## Production Readiness Scale

| Score    | Level          | Action                                |
| -------- | -------------- | ------------------------------------- |
| 9.0-10.0 | Exceptional    | None — use as reference               |
| 8.0-8.9  | Excellent      | Optional refinement                   |
| 7.0-7.9  | Good           | Address high-priority issues          |
| 6.0-6.9  | Adequate       | Fix critical issues before production |
| 5.0-5.9  | Below Standard | Rework required                       |
| 4.0-4.9  | Poor           | Substantial redesign needed           |
| 1.0-3.9  | Unacceptable   | Complete rework required              |

## 6 Evaluation Dimensions

### Module Workflow (creating reusable modules)

| #   | Dimension              | Weight | Key Criteria                                                                                 |
| --- | ---------------------- | ------ | -------------------------------------------------------------------------------------------- |
| 1   | Resource Design        | 25%    | Raw resources with secure defaults, conditional creation, proper dependencies                |
| 2   | Security & Compliance  | 30%    | Encryption, IAM least privilege, no credentials, audit logs. **<5.0 = Not Production Ready** |
| 3   | Code Quality           | 15%    | `terraform fmt`, naming conventions, validation, DRY, file organization                      |
| 4   | Variables & Outputs    | 10%    | Type constraints, validation rules, secure defaults, descriptions                            |
| 5   | Testing                | 10%    | `.tftest.hcl` coverage, mock providers, scenario groups, assertion quality                   |
| 6   | Constitution Alignment | 10%    | Matches design.md, constitution MUST compliance                                              |

**Module score formula**: `(D1 x 0.25) + (D2 x 0.30) + (D3 x 0.15) + (D4 x 0.10) + (D5 x 0.10) + (D6 x 0.10)`

### Consumer Workflow (composing from registry modules)

| #   | Dimension              | Weight | Key Criteria                                                                                               |
| --- | ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Module Usage           | 25%    | Private registry modules, semantic versioning, minimal raw resources (glue only)                           |
| 2   | Security & Compliance  | 30%    | Module secure defaults honoured, no credentials, dynamic auth, audit logs. **<5.0 = Not Production Ready** |
| 3   | Code Quality           | 15%    | `terraform fmt`, naming, wiring clarity, file organization                                                 |
| 4   | Variables & Outputs    | 10%    | Type constraints, validation rules, defaults, descriptions                                                 |
| 5   | Wiring & Integration   | 10%    | Module output-to-input connections, type compatibility, no circular deps                                   |
| 6   | Constitution Alignment | 10%    | Matches consumer-design.md, constitution MUST compliance                                                   |

**Consumer score formula**: `(D1 x 0.25) + (D2 x 0.30) + (D3 x 0.15) + (D4 x 0.10) + (D5 x 0.10) + (D6 x 0.10)`

### Provider Workflow (implementing provider resources)

| #   | Dimension              | Weight | Key Criteria                                                                                       |
| --- | ---------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| 1   | Schema Design          | 25%    | Typed attributes, validators, plan modifiers, computed fields                                      |
| 2   | Security & Compliance  | 30%    | Sensitive marking, no secrets in errors/logs, credential handling. **<5.0 = Not Production Ready** |
| 3   | Code Quality           | 15%    | Go conventions, error handling, Plugin Framework patterns                                          |
| 4   | CRUD Operations        | 10%    | Create, Read, Update, Delete, Import implemented correctly                                         |
| 5   | Testing                | 10%    | Acceptance test coverage, scenario groups, check functions                                         |
| 6   | Constitution Alignment | 10%    | Matches provider-design.md, constitution MUST compliance                                           |

**Provider score formula**: `(D1 x 0.25) + (D2 x 0.30) + (D3 x 0.15) + (D4 x 0.10) + (D5 x 0.10) + (D6 x 0.10)`

## Security Override

**Applies to all workflows**: If D2 (Security & Compliance) < 5.0, force "Not Production Ready" regardless of overall score.

## Severity Classification

- **CRITICAL (P0)**: Constitution MUST violations, hardcoded credentials, public databases, validation failures, missing encryption
- **HIGH (P1)**: Constitution SHOULD violations, unencrypted data at rest, overly permissive IAM, missing audit logging
- **MEDIUM (P2)**: Code quality issues, formatting violations, incomplete test/validation coverage
- **LOW (P3)**: Style improvements, additional documentation, refactoring opportunities

## Evidence Requirements Per Dimension

### Module/Consumer Workflows

- D1: Quote module sources or resource blocks, identify raw resources (consumer: flag non-glue raw resources), suggest registry alternatives
- D2: File:line + CVE/CWE reference (if applicable) + severity + code fix
- D3: Format violations, missing docs, duplication with suggested refactoring
- D4: Hardcoded values, missing validation, missing outputs, missing descriptions
- D5: Module — missing test files, assertion gaps, mock provider issues; Consumer — wiring validation gaps, `terraform validate` issues
- D6: Design deviations with design.md section refs, constitution violations with section citations

### Provider Workflow

- D1: Schema attribute issues with file:line, missing validators/plan modifiers
- D2: Sensitive attribute gaps, secrets in error messages, credential handling issues
- D3: Go convention violations, Plugin Framework anti-patterns, error handling gaps
- D4: Missing CRUD operations, incorrect API mappings, import issues
- D5: Missing test functions, inadequate check functions, config function issues
- D6: Design deviations with provider-design.md section refs, constitution violations

## Refinement Options (when score < 8.0)

- **A (Auto-fix)**: Fix all P0 issues, re-evaluate (max 3 iterations)
- **B (Interactive)**: Present each issue, show fix, wait for approval
- **C (Manual)**: User fixes, agent provides guidance
- **D (Detailed)**: Generate before/after examples for top 10 issues

## Quality Report Format

```markdown
## Quality Score: {FEATURE}

### Overall: {X.X}/10.0 — {Level}

| #   | Dimension             | Score | Issues                             |
| --- | --------------------- | ----- | ---------------------------------- |
| 1   | {name}                | {X.X} | {count} P0, {count} P1, {count} P2 |
| 2   | Security & Compliance | {X.X} | {count} P0, {count} P1, {count} P2 |
| ... | ...                   | ...   | ...                                |

### Production Readiness: {Ready / Not Ready}

{If Not Ready, list blocking issues}

### Top Issues

| #   | Severity | Dimension | File:Line   | Issue         | Remediation |
| --- | -------- | --------- | ----------- | ------------- | ----------- |
| 1   | {P0-P3}  | {dim}     | {file:line} | {description} | {fix}       |
| ... | ...      | ...       | ...         | ...           | ...         |
```
