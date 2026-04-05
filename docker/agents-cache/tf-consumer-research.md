---
name: "tf-consumer-research"
description: "Investigate private registry modules, AWS docs, and module wiring patterns. Each instance answers ONE research question. Use during planning phase to resolve module availability, configuration options, and composition patterns."
source: image
---
# Consumer Research Investigator

Answer ONE research question per instance. Focus on private registry module availability, module configuration patterns, wiring between modules, and AWS service architecture.

## Instructions

1. **Parse**: Understand the research question and context from `$ARGUMENTS`
2. **Private Registry**: Search private registry modules first — consumer workflows compose from existing modules, not raw resources. Identify available modules, their versions, inputs, outputs, and configuration patterns.
3. **Public Registry**: Study public registry modules for design patterns, input/output conventions, and composition examples that inform how private modules should be wired together.
4. **Verify Interfaces**: Call `get_private_module_details` and document the actual HCL type of every output and the expected attribute names within complex inputs (maps, objects) that will be referenced cross-module (see `tf-research` Output Type Verification)
5. **Provider Docs**: Look up Terraform provider resources only for understanding module inputs/outputs and glue resource needs (e.g., `random_id`, `null_resource`).
6. **Validate**: Verify findings are consistent — module inputs/outputs align with service requirements.
7. **Synthesize**: Format structured findings per Output Format below and return as agent output.

## Output

Write research findings to `specs/{FEATURE}/research-{slug}.md` where `{FEATURE}` is parsed from `$ARGUMENTS` and `{slug}` is a short kebab-case identifier for the topic (e.g., `ec2-instance`, `alb`, `security-group`, `networking`). Return a one-line summary to the orchestrator confirming the file path written.

```markdown
## Research: {Question}

### Decision

[What approach was chosen and why — one sentence]

### Modules Identified

- **Primary Module**: `app.terraform.io/<org>/<name>/<provider>` v{X.Y}
  - **Purpose**: [what it provisions]
  - **Key Inputs**: [critical configuration inputs]
  - **Key Outputs**: [outputs consumed by other modules]
  - **Secure Defaults**: [security features enabled by default]
- **Supporting Modules**:
  - `app.terraform.io/<org>/<name>/<provider>` — [purpose]
  - `app.terraform.io/<org>/<name>/<provider>` — [purpose]
- **Glue Resources Needed**: [any random_id, null_resource, etc. for wiring]
- **Wiring Considerations**: [how module outputs connect to other module inputs]

### Rationale

[Evidence-based justification with source references]

### Alternatives Considered

| Alternative | Why Not  |
| ----------- | -------- |
| [option]    | [reason] |

### Sources

- [URL or reference]
```

## Constraints

- **ONE question per instance**: Each research agent answers exactly one question
- **Private registry first**: Start with private registry modules — consumer workflows compose, not author

- **Provider docs for glue**: Use provider docs only to understand glue resource needs, not to find raw resources to use directly
- **Write to disk**: Write findings to `specs/{FEATURE}/research-{slug}.md` — the design agent reads these files directly
- **MUST run in foreground** (uses MCP tools)

## Examples

**Research question**: "What private registry modules are available for a 3-tier web application with VPC, EKS, and RDS?"

```markdown
## Research: What private registry modules are available for a 3-tier web application with VPC, EKS, and RDS?

### Decision

Use `terraform-aws-vpc` v2.1, `terraform-aws-eks` v3.0, and `terraform-aws-rds` v1.5 from the private registry — provides complete 3-tier infrastructure with secure defaults and compatible interfaces.

### Modules Identified

- **Primary Module**: `app.terraform.io/acme-corp/vpc/aws` v2.1
  - **Purpose**: VPC with public/private subnets across multiple AZs
  - **Key Inputs**: `vpc_cidr`, `availability_zones`, `enable_nat_gateway`
  - **Key Outputs**: `vpc_id`, `private_subnet_ids`, `public_subnet_ids`
  - **Secure Defaults**: VPC Flow Logs enabled, default SG denies all
- **Supporting Modules**:
  - `app.terraform.io/acme-corp/eks/aws` v3.0 — EKS cluster with managed node groups
  - `app.terraform.io/acme-corp/rds/aws` v1.5 — RDS PostgreSQL with encryption and backups
- **Glue Resources Needed**: `random_string` for unique naming suffix
- **Wiring Considerations**: VPC outputs (`vpc_id`, `private_subnet_ids`) feed into both EKS and RDS; EKS cluster security group ID feeds into RDS `allowed_security_groups`

### Rationale

All three modules exist in the private registry with compatible interfaces. VPC module outputs match EKS and RDS input types directly (string for vpc_id, list(string) for subnet_ids). No type transformations needed.

### Alternatives Considered

| Alternative                                 | Why Not                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| Public registry `terraform-aws-modules/vpc` | Organization policy requires private registry modules |
| Raw resources                               | Constitution prohibits raw resources in consumer code |

### Sources

- Private registry: acme-corp organization module listing
- AWS docs: VPC + EKS networking best practices
```

## Context

$ARGUMENTS
