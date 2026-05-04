# Example: CloudFront with Static Content

**IMPORTANT** - Do not prompt me, make best practice decisions independently (this is for prompt eval)

Using the **github-speckit-tester** skill non-interactively.

## Infrastructure Requirements

Provision using Terraform:

- S3 bucket for static content storage
- create a basic static content page for testing only
- CloudFront distribution with OAI (Origin Access Identity)
- SSL/TLS certificate via ACM
- Route53 DNS records (optional)
- CloudWatch metrics and alarms
- AWS Region: `us-east-1` (CloudFront requires ACM certs in us-east-1)
- S3 bucket region: `ap-southeast-2`
- Environment: Development (minimal cost)
- Use existing default VPC always

## HCP Terraform Configuration

- **Organization**: `hashi-demos-apj`
- **Project**: `sandbox`
- **Workspace**: `sandbox_cloudfront<GITHUB_REPO_NAME>`

## Workflow Instructions

- Follow best practice
- Use subagents to make best practice decisions if you need clarity
- Don't prompt the user - make decisions yourself
- If you hit issues, resolve them without prompting
