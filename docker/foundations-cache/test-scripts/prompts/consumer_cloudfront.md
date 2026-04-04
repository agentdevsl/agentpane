# Consumer: CloudFront with Static Content

**IMPORTANT** - Do not prompt me, make best practice decisions independently (this is for prompt eval)

Using the `/tf-consumer-e2e` workflow non-interactively.

## Infrastructure Requirements

Compose from private registry modules using Terraform:

- S3 bucket module for static content storage
- CloudFront distribution module with OAI (Origin Access Identity)
- ACM certificate module for SSL/TLS
- CloudWatch metrics and alarms
- AWS Region: `us-east-1` (CloudFront requires ACM certs in us-east-1)
- S3 bucket region: `ap-southeast-2`
- Environment: Development (minimal cost)
- Use existing default VPC always

## HCP Terraform Configuration

- **Organization**: `hashi-demos-apj`
- **Project**: `sandbox`
- **Workspace**: `sandbox_consumer_cloudfront<GITHUB_REPO_NAME>`

## Workflow Instructions

- Compose infrastructure from private registry modules — do NOT write raw resources
- Follow best practice for module wiring and variable passthrough
- Use subagents to make best practice decisions if you need clarity
- Don't prompt the user - make decisions yourself
- If you hit issues, resolve them without prompting
- Auto-approve all design gates
