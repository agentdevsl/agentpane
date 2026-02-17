# Agent-as-a-Judge Evaluation Criteria

**Purpose**: This document defines the evaluation framework, scoring rubrics, and quality standards used by all judge agents in the Speckit workflow.

**Version**: 1.0
**Last Updated**: 2025-01-07
**Authority**: These criteria are authoritative for all `/speckit.review-*` commands

---

## Core Principles

### 1. Evidence-Based Evaluation

**All judgments must be grounded in observable evidence:**

- Cite specific file locations (file:line references)
- Quote relevant text when identifying issues
- Provide concrete examples, not generic observations
- Track findings consistently across iterations

### 2. Actionable Feedback

**Every issue identified must include concrete remediation:**

- Specific actions the user can take
- Code examples showing before/after when applicable
- Prioritization (P0/P1/P2/P3) based on impact
- Clear acceptance criteria for resolution

### 3. Calibrated Scoring

**Scores must be consistent and comparable:**

- Use the full 1-10 scale (avoid clustering at 7-8)
- Score against industry standards, not project-specific baselines
- Re-evaluation of unchanged content should yield consistent scores (±0.5 variance)
- Document scoring rationale with specific evidence

### 4. Iterative Improvement Tracking

**Support continuous quality growth:**

- Store evaluation history in JSONL format
- Calculate improvement deltas between iterations
- Track which issues were addressed from previous evaluations
- Measure judge-human agreement correlation (target: >0.80 Pearson)

### 5. Constitution Authority

**Project constitution is non-negotiable:**

- Constitution violations are automatically CRITICAL severity
- MUST principles are requirements, not guidelines
- SHOULD principles are strong recommendations (HIGH severity if violated)
- MAY principles are optional (LOW severity if not followed)

---

## Scoring Rubrics

### Overall Score Interpretation

**Production Readiness Scale:**

| Score Range | Readiness Level | Interpretation                                  | Action Required                       |
| ----------- | --------------- | ----------------------------------------------- | ------------------------------------- |
| 9.0-10.0    | Exceptional     | Best-in-class quality; exemplary work           | None; use as reference example        |
| 8.0-8.9     | Excellent       | Production-ready; minor polish possible         | Optional refinement only              |
| 7.0-7.9     | Good            | Production-ready; some improvements recommended | Address high-priority issues          |
| 6.0-6.9     | Adequate        | Functional but needs refinement                 | Fix critical issues before production |
| 5.0-5.9     | Below Standard  | Significant improvements needed                 | Rework required; re-evaluate          |
| 4.0-4.9     | Poor            | Major quality concerns                          | Substantial redesign needed           |
| 3.0-3.9     | Very Poor       | Fundamental issues present                      | Complete rework required              |
| 1.0-2.9     | Unacceptable    | Critical failures; not fit for purpose          | Start over or major intervention      |

### Dimension-Specific Scoring Guidelines

Each evaluation dimension uses a 1-10 scale with specific criteria. Scores should reflect:

**9-10 (Exceptional)**: Goes above and beyond; demonstrates mastery; could serve as template for others
**7-8 (Good)**: Meets all requirements well; minor improvements possible; ready for production
**5-6 (Adequate)**: Meets minimum requirements; noticeable gaps; needs improvement
**3-4 (Poor)**: Significant issues; fails to meet multiple requirements; substantial rework needed
**1-2 (Unacceptable)**: Critical failures; does not meet basic standards; complete rework required

---

## Specification Quality Criteria (speckit.review-spec)

### Dimension 1: Clarity & Completeness (Weight: 25%)

**What to Evaluate:**

- All mandatory sections present and substantive
- Clear problem statement and user value
- Comprehensive requirements (functional + non-functional)
- Well-defined scope (inclusions AND exclusions)
- Zero unresolved `[NEEDS CLARIFICATION]` markers
- Edge cases identified

**Red Flags:**

- Missing mandatory sections
- Vague or ambiguous requirements
- No scope boundaries defined
- Multiple `[NEEDS CLARIFICATION]` markers
- Edge cases not considered

**Evidence to Cite:**

- Missing sections by name
- Vague requirements with line numbers
- Scope statement presence/absence
- Count of clarification markers

### Dimension 2: Testability & Measurability (Weight: 20%)

**What to Evaluate:**

- Requirements written as testable statements
- Success criteria include quantitative metrics
- Acceptance criteria are objective
- No vague adjectives without metrics ("fast", "scalable")
- User scenarios define observable outcomes

**Red Flags:**

- "The system should be fast" (no metric)
- "Must be secure" (no specific criteria)
- "Should scale" (no target capacity)
- Success criteria are subjective
- Requirements use "should" without measurable definition

**Evidence to Cite:**

- Vague requirements with suggested metrics
- Missing quantitative criteria
- Subjective vs objective acceptance criteria

### Dimension 3: Technology Agnosticism (Weight: 20%)

**What to Evaluate:**

- Zero implementation details (frameworks, languages, tools, APIs)
- Focused on WHAT and WHY, never HOW
- Written for business stakeholders
- Success criteria describe user outcomes
- No specific technologies in requirements

**Red Flags:**

- "Build with React" (implementation detail)
- "Use PostgreSQL database" (tech-specific)
- "API should return JSON" (format detail)
- "Deploy on AWS Lambda" (platform-specific)
- Success criteria mention frameworks or tools

**Evidence to Cite:**

- Technology references with line numbers
- Implementation details that should be abstracted
- How to reframe as outcome-focused

### Dimension 4: Constitution Alignment (Weight: 20%)

**What to Evaluate:**

- No violations of MUST principles
- Security-first mindset in requirements
- Module-first architecture implied (for IaC)
- Ephemeral testing patterns mentioned
- Compliance with governance principles

**Red Flags:**

- Requirements violate constitution MUST principles
- Security not mentioned in requirements
- Hardcoded credentials implied
- Static infrastructure assumptions (vs ephemeral)
- No mention of testing or validation

**Evidence to Cite:**

- Specific constitution principle violations (§X.Y)
- Missing security requirements
- How to align with constitution

### Dimension 5: User-Centricity & Value (Weight: 15%)

**What to Evaluate:**

- Clear user personas and goals
- User scenarios capture realistic workflows
- Requirements prioritized by user value (P1/P2/P3)
- User stories follow format (As a... I want... So that...)
- Edge cases consider user pain points
- Success criteria measure user satisfaction

**Red Flags:**

- No user personas defined
- Generic user scenarios
- Feature-focused not user-focused
- No prioritization by user value
- Success criteria are internal metrics only

**Evidence to Cite:**

- User persona quality
- User story format compliance
- Value prioritization presence

---

## Code Quality Criteria (speckit.review-code)

### Dimension 1: Module Usage & Architecture (Weight: 25%)

**What to Evaluate:**

- Private registry modules (`app.terraform.io/<org>/`)
- Semantic versioning constraints (`~> X.Y.Z`)
- Minimal raw resource declarations
- Proper module composition
- No duplicated resource patterns

**Red Flags:**

- Public registry usage (registry.terraform.io)
- No version constraints on modules
- Multiple raw resource blocks for same pattern
- Hardcoded module sources (../local/path)
- Module outputs not consumed downstream

**Evidence to Cite:**

- Module source with file:line
- Missing version constraints
- Raw resources that should use modules
- Specific private modules to use instead

### Dimension 2: Security & Compliance (Weight: 30%)

**What to Evaluate:**

- NO hardcoded credentials
- Encryption at rest (S3, RDS, EBS)
- Encryption in transit (HTTPS, TLS)
- IAM least privilege (no `*` permissions)
- Network security (private subnets, security groups)
- Sensitive outputs marked
- No public exposure (unless required)
- Audit logging enabled

**Red Flags:**

- `aws_access_key_id = "AKIA..."` (hardcoded)
- `actions = ["*"]` in IAM policies
- `0.0.0.0/0` ingress on sensitive ports
- `publicly_accessible = true` on databases
- modules sourced from public registry
- Unencrypted S3 buckets
- Missing `sensitive = true` on secrets
- No CloudTrail or logging

**Evidence to Cite:**

- Security issues with CVE/CWE if applicable
- File:line for each vulnerability
- Specific remediation code examples
- Pre-commit hook status

### Dimension 3: Code Quality & Maintainability (Weight: 15%)

**What to Evaluate:**

- `terraform fmt` compliant
- Meaningful naming (no "example", "test")
- Variable validation (type constraints, rules)
- Documentation (descriptions on all variables/outputs)
- DRY principle (no copy-paste)
- Logical file organization
- Comments for complex logic

**Red Flags:**

- Inconsistent formatting
- Generic names (resource "aws_instance" "test")
- Variables without descriptions
- Copy-pasted resource blocks
- No variable validation rules
- Missing output descriptions

**Evidence to Cite:**

- Formatting violations
- Missing documentation
- Code duplication with refactoring suggestions

### Dimension 4: Variable & Output Management (Weight: 10%)

**What to Evaluate:**

- All variables in `variables.tf`
- Type constraints on all variables
- Validation rules for critical variables
- Sensible defaults where appropriate
- Required variables marked (no defaults)
- Output values for downstream consumption
- Sensitive outputs marked
- Output descriptions

**Red Flags:**

- Hardcoded values in resources
- Variables without type constraints
- No validation on CIDR blocks or names
- Inappropriate defaults (security-sensitive values)
- Missing outputs for created resources
- Secrets in outputs without `sensitive = true`

**Evidence to Cite:**

- Hardcoded values with suggested variable names
- Missing validation rules
- Suggested output values

### Dimension 5: Testing & Validation (Weight: 10%)

**What to Evaluate:**

- `terraform validate` passes
- `.tftest.hcl` files present
- `sandbox.auto.tfvars.example` provided
- Pre-commit hooks configured
- `override.tf` for cloud backend (gitignored)
- Test assertions validate behavior

**Red Flags:**

- Validation errors present
- No test files
- No example configurations
- Pre-commit hooks not configured
- Missing override.tf template

**Evidence to Cite:**

- Validation errors (exact messages)
- Missing test files
- Pre-commit configuration status

### Dimension 6: Constitution & Plan Alignment (Weight: 10%)

**What to Evaluate:**

- Matches `plan.md` architecture
- Constitution MUST compliance
- Ephemeral testing pattern
- No workspace creation
- Proper git workflow
- Naming conventions aligned
- Provider-specific patterns (AWS/GCP/Azure)

**Red Flags:**

- Deviations from plan without justification
- Constitution MUST violations
- Hardcoded credentials (not workspace vars)
- Workspace creation code
- Naming doesn't match constitution

**Evidence to Cite:**

- Plan deviations with plan.md references
- Constitution violations with §X.Y references
- How to align with plan/constitution

---

## Technical Quality Criteria (speckit.analyze dual-pass)

### Dimension A: Architecture Soundness (Weight: 30%)

**What to Evaluate:**

- Module selection appropriateness
- Infrastructure patterns match best practices
- Scalability considerations
- Separation of concerns
- Technology choices justified

**Red Flags:**

- Wrong modules for requirements
- Anti-patterns in design
- No scalability considerations
- Monolithic architecture
- Technology choices unjustified

### Dimension B: Security & Compliance Design (Weight: 25%)

**What to Evaluate:**

- Security patterns in plan
- Compliance requirements mapped
- Defense-in-depth strategies
- Least privilege principles
- Audit and monitoring

**Red Flags:**

- Security as afterthought
- Compliance not addressed
- Single point of failure
- Overly permissive defaults
- No monitoring planned

### Dimension C: Task Quality & Feasibility (Weight: 20%)

**What to Evaluate:**

- Atomic tasks
- Dependencies sequenced
- Parallel tasks identified
- Effort reasonable
- Clear acceptance criteria

**Red Flags:**

- Tasks too broad
- Dependencies unclear
- No parallel execution identified
- Effort estimates missing
- Vague acceptance criteria

### Dimension D: Testing Strategy (Weight: 15%)

**What to Evaluate:**

- Test cases for requirements
- Validation approach defined
- Edge case coverage
- Integration testing
- Performance/security testing

**Red Flags:**

- No testing strategy
- Edge cases ignored
- No integration tests
- Performance not tested
- Security testing missing

### Dimension E: Documentation & Knowledge Transfer (Weight: 10%)

**What to Evaluate:**

- Architectural decisions explained
- Technical rationale provided
- Runbook/operational guidance
- Knowledge captured
- Assumptions documented

**Red Flags:**

- No decision rationale
- Missing operational guidance
- Assumptions not documented
- Knowledge locked in code

---

## Severity Classification

### Issue Severity Levels

**CRITICAL (P0)** - Must fix before proceeding:

- Constitution MUST principle violations
- Security vulnerabilities (hardcoded credentials, public databases)
- Blocking functional issues (validation fails, missing required sections)
- Data loss or corruption risks
- Compliance violations with legal/regulatory impact

**HIGH (P1)** - Should fix before production:

- Constitution SHOULD principle violations
- Security weaknesses (overly permissive IAM, unencrypted data)
- Significant technical debt
- Missing critical documentation
- Performance bottlenecks
- Testability issues

**MEDIUM (P2)** - Recommended improvements:

- Constitution MAY principle not followed
- Code quality issues (formatting, naming)
- Missing nice-to-have documentation
- Minor optimization opportunities
- Incomplete test coverage

**LOW (P3)** - Nice to have:

- Style improvements
- Additional documentation
- Refactoring for cleaner code
- Future enhancements

---

## Judge-Human Agreement Tracking

### Correlation Measurement

**Target**: Pearson correlation >0.80 between judge scores and human expert scores

**Methodology**:

1. Collect judge scores for N evaluations (N ≥ 5)
2. Collect human expert scores for same artifacts
3. Calculate Pearson correlation coefficient
4. Track over time to measure judge reliability

**Storage Format** (JSONL):

```jsonl
{
  "timestamp": "ISO-8601",
  "feature": "branch-name",
  "human_score": 7.5,
  "judge_score": 7.2,
  "delta": 0.3,
  "dimension": "overall",
  "evaluator": "claude-sonnet-4-6"
}
```

**Calibration**:

- If correlation < 0.70: Adjust scoring rubrics or judge prompts
- If correlation 0.70-0.79: Minor calibration needed
- If correlation ≥ 0.80: Judge is reliable
- If correlation > 0.90: Judge may be overfitting; validate with new data

### Evaluation History Storage

**Location**: `<FEATURE_DIR>/evaluations/`

**Files**:

- `spec-reviews.jsonl` - Specification quality evaluations
- `code-reviews.jsonl` - Terraform code quality evaluations
- `technical-quality.jsonl` - Technical decision quality (analyze dual-pass)
- `judge-human-correlation.jsonl` - Human validation comparisons

**Schema Example**:

```jsonl
{
  "timestamp": "2025-01-07T10:30:00Z",
  "iteration": 1,
  "overall_score": 6.8,
  "dimension_scores": {
    "clarity": 7.5,
    "testability": 6,
    "tech_agnostic": 8,
    "constitution": 6.5,
    "user_centric": 6
  },
  "readiness": "refinement_recommended",
  "critical_issues": 2,
  "high_priority_issues": 3,
  "evaluator": "claude-sonnet-4-6"
}
```

---

## Iterative Refinement Protocol

### Multi-Pass Evaluation

**When to Use**:

- Initial score < threshold (7.0 for specs, 8.0 for code)
- User requests auto-refinement
- Tracking improvement trajectory

**Process**:

1. Run initial evaluation → Score X.X
2. If score < threshold, identify top N issues (N = 3-5)
3. Apply fixes (auto or interactive)
4. Re-run evaluation → Score Y.Y
5. Calculate delta: Y.Y - X.X
6. Repeat until score ≥ threshold (max 3 iterations)
7. Store all iterations in evaluation history

**Improvement Tracking**:

```markdown
| Iteration | Score | Delta | Issues Fixed | Status          |
| --------- | ----- | ----- | ------------ | --------------- |
| 1         | 6.5   | -     | -            | Below threshold |
| 2         | 7.2   | +0.7  | 3/5          | Above threshold |
```

### Refinement Options

**A) Auto-fix Critical Issues**:

- Agent automatically applies fixes for CRITICAL (P0) issues
- Uses Edit tool with specific line-level changes
- Re-evaluates after fixes applied
- Max 3 iterations to prevent infinite loops

**B) Interactive Refinement**:

- Present each issue one-by-one
- Show suggested fix with before/after code
- User approves or modifies each fix
- Apply approved changes incrementally
- Re-evaluate after all fixes applied

**C) Manual Refinement**:

- Provide detailed improvement roadmap
- User updates artifacts manually
- User re-runs evaluation when ready

**D) View Detailed Remediation**:

- Generate code examples for top N issues
- Show specific file:line changes needed
- User applies manually or copies examples

---

## Quality Metrics & Reporting

### Key Performance Indicators

**Judge Performance**:

- Judge-human correlation: Target >0.80 Pearson
- Score consistency: ±0.5 variance on re-evaluation
- Calibration drift: <5% monthly change in average scores

**Artifact Quality Trends**:

- Average spec quality over time
- Average code quality over time
- Issues per evaluation (declining trend = improvement)
- Iterations to threshold (lower = better initial quality)

**Remediation Effectiveness**:

- Score improvement per iteration (delta)
- Issues resolved per iteration (%)
- Time to threshold (iterations × avg time)

### Monthly Calibration Review

**Process** (recommended monthly):

1. Sample 10 recent evaluations
2. Have human expert score same artifacts
3. Calculate correlation coefficient
4. If correlation < 0.80, identify calibration gaps
5. Update scoring rubrics or judge prompts
6. Re-test on hold-out set
7. Deploy calibrated judges

---

## Usage Guidelines

### For Specification Reviews (`/speckit.review-spec`)

**When to Run**:

- After `/speckit.specify` completes
- Before `/speckit.plan` starts
- After addressing clarification questions
- When iterating on requirements

**Expected Outcomes**:

- Score ≥ 7.0: Ready for planning
- Score 5.0-6.9: Refinement recommended
- Score < 5.0: Rework required

### For Code Reviews (`/speckit.review-code`)

**When to Run**:

- After `/speckit.implement` completes
- Before committing code
- Before creating pull request
- After addressing security findings

**Expected Outcomes**:

- Score ≥ 8.0: Production-ready
- Score 6.0-7.9: Minor fixes needed
- Score < 6.0: Not production-ready

### For Technical Quality (`/speckit.analyze` dual-pass)

**When to Run**:

- After `/speckit.tasks` completes
- Before `/speckit.implement` starts
- When validating architecture decisions

**Expected Outcomes**:

- Score ≥ 7.0: High confidence in implementation
- Score 6.0-6.9: Good design, minor improvements
- Score < 6.0: Redesign recommended

---

## Appendix: Common Patterns

### Common Specification Issues

1. **Vague Requirements**: "System should be fast" → "System responds in <2 seconds for 95% of requests"
2. **Implementation Details**: "Use React" → "Interface updates without full page reload"
3. **Missing Scope**: Only inclusions → Add explicit exclusions
4. **Untestable Criteria**: "User-friendly" → "Users complete task in <3 clicks"
5. **No Prioritization**: All requirements equal → P1 (must have), P2 (should have), P3 (nice to have)

### Common Code Issues

1. **Hardcoded Credentials**: `access_key = "AKIA..."` → Use workspace variables
2. **Public Registry**: `source = "terraform-aws-modules/vpc/aws"` → `source = "app.terraform.io/myorg/vpc/aws"`
3. **No Version Constraint**: `version = "~> 5.0"` missing → Add semantic versioning
4. **Wildcard Permissions**: `actions = ["*"]` → Specific actions only
5. **Unencrypted Data**: `encryption = false` → `encryption = true` or use encrypted module
6. **Missing Validation**: No variable validation → Add `validation { condition = ... }`

### Common Technical Design Issues

1. **Wrong Module Selection**: Using compute module for storage needs → Use storage module
2. **No Scalability Plan**: Static instance count → Auto-scaling configuration
3. **Missing Monitoring**: No observability → Add CloudWatch/logging
4. **Poor Task Breakdown**: "Implement feature" → Atomic subtasks with dependencies
5. **No Testing Strategy**: Tasks don't include tests → Add test tasks per requirement

---

**Document Maintenance**:

- Review quarterly for calibration drift
- Update after significant correlation deviations
- Incorporate learnings from human validation
- Version control all changes with changelog
