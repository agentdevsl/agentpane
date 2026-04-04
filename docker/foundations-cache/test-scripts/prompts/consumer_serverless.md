# Consumer: Serverless Application

**IMPORTANT** - Do not prompt me, make best practice decisions independently (this is for prompt eval)

Using the `/tf-consumer-e2e` workflow non-interactively.

## Infrastructure Requirements

Compose from private registry modules using Terraform:

- Lambda function module with API Gateway integration
- DynamoDB table module for data storage
- S3 bucket module for static assets
- CloudWatch Logs and alarms for observability
- IAM role modules with least-privilege policies
- AWS Region: `ap-southeast-2`
- Environment: Development (minimal cost)
- Use existing default VPC always

## HCP Terraform Configuration

- **Organization**: `hashi-demos-apj`
- **Project**: `sandbox`
- **Workspace**: `sandbox_consumer_serverless<GITHUB_REPO_NAME>`

## Workflow Instructions

- Compose infrastructure from private registry modules — do NOT write raw resources
- Follow best practice for module wiring and variable passthrough
- Use subagents to make best practice decisions if you need clarity
- Don't prompt the user - make decisions yourself
- If you hit issues, resolve them without prompting
- Auto-approve all design gates
