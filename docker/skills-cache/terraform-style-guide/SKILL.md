---
name: "terraform-style-guide"
description: "Generate Terraform HCL code following HashiCorp's official style conventions and best practices. Use when writing, reviewing, or generating Terraform configurations."
source: image
---
# Terraform Style Guide

Generate and maintain Terraform code following HashiCorp's official style conventions and best practices.

**Reference:** [HashiCorp Terraform Style Guide](https://developer.hashicorp.com/terraform/language/style)

## Code Generation Strategy

When generating Terraform module code:

1. Start with version constraints and provider requirements in `versions.tf`
2. Create data sources before dependent resources
3. Build resources in dependency order with conditional creation (`count` or `for_each`)
4. Add outputs for key resource attributes, using `try()` for conditional resources
5. Use variables for all configurable values with secure defaults
6. Use `this` as the primary resource name for single instances
7. Prefer `for_each` over `count` for resource iteration (stable addresses)
8. Provider configuration belongs in `examples/`, NOT the root module

## File Organization

| File | Purpose |
|------|---------|
| `versions.tf` | Terraform and provider version constraints (required_version + required_providers) |
| `main.tf` | Primary resources and data sources |
| `variables.tf` | Input variable declarations (alphabetical) |
| `outputs.tf` | Output value declarations (alphabetical) |
| `locals.tf` | Local value declarations |

### Example Structure

```hcl
# versions.tf
terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# variables.tf
variable "environment" {
  description = "Target deployment environment"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

# locals.tf
locals {
  common_tags = {
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# main.tf
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-vpc"
  })
}

# outputs.tf
output "vpc_id" {
  description = "ID of the created VPC"
  value       = aws_vpc.main.id
}
```

## Code Formatting

### Block Organization

Arguments precede blocks, with meta-arguments first:

```hcl
resource "aws_instance" "example" {
  # Meta-arguments
  count = 3

  # Arguments
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"

  # Blocks
  root_block_device {
    volume_size = 20
  }

  # Lifecycle last
  lifecycle {
    create_before_destroy = true
  }
}
```

## Variables

Every variable must include `type` and `description`:

```hcl
variable "instance_type" {
  description = "EC2 instance type for the web server"
  type        = string
  default     = "t2.micro"

  validation {
    condition     = contains(["t2.micro", "t2.small", "t2.medium"], var.instance_type)
    error_message = "Instance type must be t2.micro, t2.small, or t2.medium."
  }
}

variable "database_password" {
  description = "Password for the database admin user"
  type        = string
  sensitive   = true
}
```

## Outputs

Every output must include `description`:

```hcl
output "instance_id" {
  description = "ID of the EC2 instance"
  value       = aws_instance.web.id
}

output "database_password" {
  description = "Database administrator password"
  value       = aws_db_instance.main.password
  sensitive   = true
}
```

## Dynamic Resource Creation

### Prefer for_each over count

```hcl
# Bad - count for multiple resources
resource "aws_instance" "web" {
  count = var.instance_count
  tags  = { Name = "web-${count.index}" }
}

# Good - for_each with named instances
variable "instance_names" {
  type    = set(string)
  default = ["web-1", "web-2", "web-3"]
}

resource "aws_instance" "web" {
  for_each = var.instance_names
  tags     = { Name = each.key }
}
```

### count for Conditional Creation

```hcl
resource "aws_cloudwatch_metric_alarm" "cpu" {
  count = var.enable_monitoring ? 1 : 0

  alarm_name = "high-cpu-usage"
  threshold  = 80
}
```

## Security Best Practices

Apply secure defaults per `tf-security-baselines` skill.

## Version Pinning

```hcl
terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"  # Minimum version supporting required features
    }
  }
}
```

## Code Review Checklist

- [ ] Code formatted with `terraform fmt`
- [ ] Configuration validated with `terraform validate`
- [ ] Files organized according to standard structure
- [ ] All variables have type and description
- [ ] All outputs have descriptions
- [ ] Resource names use descriptive nouns with underscores
- [ ] Version constraints pinned explicitly
- [ ] Sensitive values marked with `sensitive = true`
- [ ] No hardcoded credentials or secrets
- [ ] Security best practices applied

---

*Based on: [HashiCorp Terraform Style Guide](https://developer.hashicorp.com/terraform/language/style)*
