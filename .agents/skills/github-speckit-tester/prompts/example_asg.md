# Example: Auto-Scaling Group with ALB

**IMPORTANT** - Do not prompt me, make best practice decisions independently (this is for prompt eval)

Using the **github-speckit-tester** skill non-interactively.

## Infrastructure Requirements

Provision using Terraform:

- Auto-scaling group with launch template
- Target tracking policies
- create basic static content for testing
- ALB with health checks across 2 AZs
- CloudWatch dashboards
- AWS Region: `ap-southeast-2`
- Environment: Development (minimal cost)
- Use existing default VPC always

## HCP Terraform Configuration

- **Organization**: `hashi-demos-apj`
- **Project**: `sandbox`
- **Workspace**: `sandbox_asg<GITHUB_REPO_NAME>`

## Workflow Instructions

- Follow best practice
- Use subagents to make best practice decisions if you need clarity
- Don't prompt the user - make decisions yourself
- If you hit issues, resolve them without prompting
