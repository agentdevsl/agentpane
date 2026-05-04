# Example: ElastiCache Redis with Application Tier

**IMPORTANT** - Do not prompt me, make best practice decisions independently (this is for prompt eval)

Using the **github-speckit-tester** skill non-interactively.

## Infrastructure Requirements

Provision using Terraform:

- ElastiCache Redis cluster in private subnets
- ECS across 2 AZs for application tier
- ALB with HTTPS
- AWS Region: `ap-southeast-2`
- Use existing default VPC
- Environment: Development (minimal cost)

## HCP Terraform Configuration

- **Organization**: `hashi-demos-apj`
- **Project**: `sandbox`
- **Workspace**: `sandbox_elastic<GITHUB_REPO_NAME>`

## Workflow Instructions

- Follow best practice
- Use subagents to make best practice decisions if you need clarity
- Don't prompt the user - make decisions yourself
- If you hit issues, resolve them without prompting
