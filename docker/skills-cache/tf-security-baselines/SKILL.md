---
name: "tf-security-baselines"
description: "AWS security assessment domains, risk rating framework, CIS/NIST reference baselines, and evidence-based finding format. Use when reviewing AWS security posture, assessing risk, or applying CIS/NIST baselines to Terraform configurations."
source: image
---
# Terraform Security Baselines

## Agent Role

Expert in cloud security architecture and AWS Well-Architected Framework's Security Pillar. Identify vulnerabilities, misconfigurations, and compliance gaps with evidence-based, actionable recommendations.

## Critical Requirements

- **MANDATORY**: Every finding requires risk rating (Critical/High/Medium/Low) + justification
- **MANDATORY**: Every recommendation requires authoritative citation (AWS docs, CIS, NIST, OWASP)
- **Evidence-Based**: File:line references + code quotes + before/after fixes
- **MCP-First**: Use AWS Knowledge MCP tools to verify current documentation
- **Prioritize**: Order findings by severity and exploitation likelihood

## Security Domains

1. **IAM**: Least privilege, no wildcards, MFA enforcement, specific resource ARNs
2. **Data Protection**: Encryption at rest/transit, KMS, no hardcoded credentials, ephemeral secrets
3. **Network Security**: Private subnets, security groups deny-all default, no 0.0.0.0/0 ingress
4. **Logging & Monitoring**: CloudTrail, VPC Flow Logs, alerting, CloudWatch
5. **Resilience**: Backup, disaster recovery, multi-AZ, auto-scaling
6. **Compliance**: Regulatory requirements, audit trails, data residency

## Risk Rating Classification

| Rating            | Action                | Examples                                                        |
| ----------------- | --------------------- | --------------------------------------------------------------- |
| **Critical (P0)** | Block deployment      | Hardcoded credentials, public S3 with sensitive data, IAM `*:*` |
| **High (P1)**     | Fix before production | Unencrypted RDS, overly permissive SG, missing CloudTrail       |
| **Medium (P2)**   | Fix in current sprint | Missing VPC Flow Logs, no MFA, weak password policy             |
| **Low (P3)**      | Add to backlog        | Missing resource tags, outdated AMI                             |

## Finding Output Format

```markdown
### [Issue Title]

**Risk Rating**: [Critical|High|Medium|Low]
**Justification**: [Why this severity]
**Finding**: [Description with file:line]
**Impact**: [Consequences if exploited]
**Recommendation**: [Remediation steps]
**Code Example**: [Before/After HCL]
**Source**: [AWS doc URL]
**Reference**: [CIS/NIST/OWASP citation]
**Effort**: [Low|Medium|High]
```

## Evaluation Standards

- AWS Well-Architected Framework Security Pillar
- AWS Security Best Practices
- CIS AWS Benchmark
- NIST Cybersecurity Framework
- OWASP Cloud Security
- Organizational Constitution (`.foundations/memory/module-constitution.md`)

## MCP Tool Usage

- `search_documentation("AWS [service] security")` → Find best practices
- `read_documentation(url)` → Get authoritative citations
- `recommend(page)` → Discover related security content
- `list_regions()`, `get_regional_availability()` → Validate region configs

## Module-Specific Security Guidance

When reviewing modules (vs consumer deployments):

- **Secure Defaults**: Modules MUST enable security features by default (encryption, private access, logging)
- **Security Toggles**: Expose security features as variables with secure defaults — consumers opt OUT, not IN
- **No Credentials**: Modules MUST NOT manage provider credentials — inherited from consumers
- **Sensitive Marking**: Variables and outputs handling secrets MUST use `sensitive = true`
- **Force Destroy**: Default to `false` for safety; examples MAY set `true` for testing

## Special Considerations

- **Dev/Test**: Relaxed security allowed but requires justification. No prod data.
- **Legacy**: Document constraints, provide incremental path, prioritize highest-risk.
- **Cost**: Acknowledge costs, offer alternatives, NEVER compromise Critical/High for cost.
