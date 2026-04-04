---
name: "tf-architecture-patterns"
description: "Terraform module design patterns, resource composition conventions, and project structure standards. Use when designing module structure, choosing resource composition patterns, or setting up project layout for AWS Terraform modules."
source: image
---
# Terraform Architecture Patterns

## Module-First Architecture

This repository develops well-structured, reusable Terraform modules using raw resources that follow HashiCorp and organizational best practices.

### Module Design Rules

- Author modules using native Terraform resources and data sources from official providers
- Follow the standard HashiCorp module structure: root module, `variables.tf`, `outputs.tf`, `examples/`, `tests/`
- Research AWS docs and provider docs before writing resource configurations
- Study well-regarded public registry modules for design patterns (e.g., `terraform-aws-modules/`)
- Expose configurable inputs with secure defaults
- Support conditional resource creation via `create_*` boolean variables
- Use semantic versioning (major.minor.patch) with clear CHANGELOG entries
- Use `>=` version constraints for providers in modules (maximize consumer compatibility)

## Project Structure Convention

```
/
├── main.tf              # Primary resource definitions
├── variables.tf         # Input variables with validation
├── outputs.tf           # Output values with descriptions
├── locals.tf            # Computed values
├── versions.tf          # Terraform and provider version constraints (required_version + required_providers)
├── README.md            # Auto-generated via terraform-docs
├── CHANGELOG.md         # Version history
├── examples/
│   ├── basic/           # Minimal usage example (with provider config)
│   └── complete/        # Full-featured example
├── tests/               # Terraform test files (.tftest.hcl)
└── .github/
    └── workflows/       # CI/CD pipelines
```

## File Organization Rules

- No monolithic files exceeding 500 lines
- No intermingling resource types without logical grouping
- No default values for security-sensitive variables
- No provider configuration in the root module
- Variables: snake_case with descriptive names
- Resources: Use `this` for single primary resource, descriptive names for multiples
- Prefer `for_each` over `count` for resource iteration (stable addresses)

## Security-First Defaults

Security defaults per constitution sections 1.2 and 4.x. Key: zero trust, encryption by default, least privilege, `sensitive = true` on secrets.
