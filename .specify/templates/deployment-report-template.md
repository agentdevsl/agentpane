# Terraform Deployment Report

**Feature**: `{{FEATURE_NAME}}`
**Branch**: `{{GIT_BRANCH}}`
**Deployed**: `{{TIMESTAMP}}`
**Deployment Status**: {{DEPLOYMENT_STATUS}}

---

## Executive Summary

### Deployment Overview

{{DEPLOYMENT_OVERVIEW}}

### Deployment Outcome

| Metric                       | Value                                 |
| ---------------------------- | ------------------------------------- |
| **Status**                   | {{STATUS_BADGE}}                      |
| **Infrastructure Resources** | {{RESOURCE_COUNT}} resources deployed |
| **Deployment Duration**      | {{DEPLOY_DURATION}}                   |
| **Total Cost Estimate**      | {{COST_ESTIMATE}}                     |
| **Compliance Status**        | {{COMPLIANCE_STATUS}}                 |

{{STATUS_BADGE}} options:

- ✅ **Successfully Deployed**
- ⚠️ **Deployed with Warnings**
- ❌ **Deployment Failed**
- 🔄 **Partial Deployment**

---

## Architecture Summary

### Infrastructure Overview

{{ARCHITECTURE_DESCRIPTION}}

### Architecture Diagram

```
{{ARCHITECTURE_DIAGRAM}}
```

### Key Components

{{KEY_COMPONENTS_TABLE}}

---

## HCP Terraform Configuration

### Organization & Project Details

| Configuration                  | Value                 |
| ------------------------------ | --------------------- |
| **HCP Terraform Organization** | `{{TFC_ORG}}`         |
| **HCP Terraform Project**      | `{{TFC_PROJECT}}`     |
| **HCP Terraform Workspace(s)** | `{{TFC_WORKSPACE}}`   |
| **Workspace URL**              | {{TFC_WORKSPACE_URL}} |
| **Terraform Version**          | `{{TF_VERSION}}`      |
| **Execution Mode**             | {{EXEC_MODE}}         |
| **Auto-Apply**                 | {{AUTO_APPLY}}        |

### Workspace Configuration

| Setting                         | Value                |
| ------------------------------- | -------------------- |
| **VCS Integration**             | {{VCS_INTEGRATION}}  |
| **Working Directory**           | `{{WORKING_DIR}}`    |
| **Terraform Working Directory** | `{{TF_WORKING_DIR}}` |
| **Trigger Patterns**            | {{TRIGGER_PATTERNS}} |
| **Auto-Destroy**                | {{AUTO_DESTROY}}     |

---

## Module & Provider Inventory

### Private Modules Utilized

| Module Name | Version | Source | Purpose |
| ----------- | ------- | ------ | ------- |

{{PRIVATE_MODULES_TABLE}}

### Public Modules Utilized

| Module Name | Version | Source | Purpose | Justification |
| ----------- | ------- | ------ | ------- | ------------- |

{{PUBLIC_MODULES_TABLE}}

### Provider Versions

| Provider | Version | Source |
| -------- | ------- | ------ |

{{PROVIDERS_TABLE}}

---

## Git & Version Control

### Repository Information

| Attribute               | Value                                 |
| ----------------------- | ------------------------------------- |
| **Feature Branch**      | `{{GIT_BRANCH}}`                      |
| **Base Branch**         | `{{BASE_BRANCH}}`                     |
| **Commit SHA**          | `{{COMMIT_SHA}}`                      |
| **Author**              | {{GIT_AUTHOR}}                        |
| **Commits in Branch**   | {{COMMIT_COUNT}}                      |
| **Files Changed**       | {{FILES_CHANGED}}                     |
| **Lines Added/Removed** | +{{LINES_ADDED}} / -{{LINES_REMOVED}} |

### Pull Request

| Attribute     | Value         |
| ------------- | ------------- |
| **PR Number** | {{PR_NUMBER}} |
| **PR Status** | {{PR_STATUS}} |
| **PR URL**    | {{PR_URL}}    |
| **Reviewers** | {{REVIEWERS}} |

---

## Resource Utilization Metrics

### Claude AI Token Usage

| Metric                    | Value                         |
| ------------------------- | ----------------------------- |
| **Total Tokens Consumed** | {{TOTAL_TOKENS}} tokens       |
| **Input Tokens**          | {{INPUT_TOKENS}} tokens       |
| **Output Tokens**         | {{OUTPUT_TOKENS}} tokens      |
| **Cache Read Tokens**     | {{CACHE_READ_TOKENS}} tokens  |
| **Cache Write Tokens**    | {{CACHE_WRITE_TOKENS}} tokens |
| **Estimated Cost**        | {{ESTIMATED_COST}}            |
| **Session Duration**      | {{SESSION_DURATION}}          |

### Agent & Tool Invocations

#### Subagent Calls

| Subagent | Invocations | Purpose | Outcome |
| -------- | ----------- | ------- | ------- |

{{SUBAGENT_TABLE}}

**Total Subagent Calls**: {{TOTAL_SUBAGENTS}}

#### Skills Invoked

| Skill | Invocations | Purpose | Outcome |
| ----- | ----------- | ------- | ------- |

{{SKILLS_TABLE}}

**Total Skill Calls**: {{TOTAL_SKILLS}}

#### Tool Call Statistics

| Tool Category            | Successful Calls | Failed Calls    | Total          |
| ------------------------ | ---------------- | --------------- | -------------- |
| **MCP Tools**            | {{MCP_SUCCESS}}  | {{MCP_FAILED}}  | {{MCP_TOTAL}}  |
| **Bash Commands**        | {{BASH_SUCCESS}} | {{BASH_FAILED}} | {{BASH_TOTAL}} |
| **File Operations**      | {{FILE_SUCCESS}} | {{FILE_FAILED}} | {{FILE_TOTAL}} |
| **Terraform Operations** | {{TF_SUCCESS}}   | {{TF_FAILED}}   | {{TF_TOTAL}}   |
| **Git Operations**       | {{GIT_SUCCESS}}  | {{GIT_FAILED}}  | {{GIT_TOTAL}}  |

---

## Failed Tool Calls & Remediations

### Summary

| Status                      | Count                |
| --------------------------- | -------------------- |
| **Total Failed Calls**      | {{FAILED_TOTAL}}     |
| **Successfully Remediated** | {{REMEDIATED_COUNT}} |
| **Unresolved**              | {{UNRESOLVED_COUNT}} |

### Detailed Failure Log

{{FAILED_CALLS_TABLE}}

---

## Workarounds vs Fixes

### Critical Distinction

This section documents issues that were **worked around** rather than **properly fixed**. These require future attention.

### Workarounds Implemented

| Issue ID | Description | Workaround Applied | Why Workaround Chosen | Future Fix Required | Priority |
| -------- | ----------- | ------------------ | --------------------- | ------------------- | -------- |

{{WORKAROUNDS_TABLE}}

### Issues Properly Fixed

| Issue ID | Description | Fix Applied | Verification Method |
| -------- | ----------- | ----------- | ------------------- |

{{FIXES_TABLE}}

**Total Workarounds**: {{WORKAROUND_COUNT}} ⚠️
**Total Proper Fixes**: {{FIX_COUNT}} ✅

---

## Security Analysis

### Security Posture Summary

| Metric                       | Value                    |
| ---------------------------- | ------------------------ |
| **Overall Security Score**   | {{SECURITY_SCORE}}/10    |
| **Critical Vulnerabilities** | {{CRITICAL_VULNS}}       |
| **High Severity Issues**     | {{HIGH_VULNS}}           |
| **Medium Severity Issues**   | {{MEDIUM_VULNS}}         |
| **Low Severity Issues**      | {{LOW_VULNS}}            |
| **Security Tool Compliance** | {{SECURITY_COMPLIANCE}}% |

### Pre-Commit Security Reports

#### terraform validate

| Status              | Errors              | Warnings              | Details              |
| ------------------- | ------------------- | --------------------- | -------------------- |
| {{VALIDATE_STATUS}} | {{VALIDATE_ERRORS}} | {{VALIDATE_WARNINGS}} | {{VALIDATE_DETAILS}} |

**Output**:

```
{{VALIDATE_OUTPUT}}
```

#### trivy

| Status           | Critical           | High           | Medium           | Low           | Total Issues    |
| ---------------- | ------------------ | -------------- | ---------------- | ------------- | --------------- |
| {{TRIVY_STATUS}} | {{TRIVY_CRITICAL}} | {{TRIVY_HIGH}} | {{TRIVY_MEDIUM}} | {{TRIVY_LOW}} | {{TRIVY_TOTAL}} |

**Key Findings**:
{{TRIVY_FINDINGS}}

#### vault-radar-scan

| Status           | Secrets Found     | Files Scanned   | Risk Level     |
| ---------------- | ----------------- | --------------- | -------------- |
| {{VAULT_STATUS}} | {{VAULT_SECRETS}} | {{VAULT_FILES}} | {{VAULT_RISK}} |

**Findings**:
{{VAULT_FINDINGS}}

### Security Recommendations

{{SECURITY_RECOMMENDATIONS}}

---

## Sentinel Policy Evaluation

### Policy Set Overview

| Policy Set | Version | Enforcement Level | Status |
| ---------- | ------- | ----------------- | ------ |

{{SENTINEL_POLICY_SETS}}

### Advisory Warnings

| Policy | Severity | Message | Recommendation |
| ------ | -------- | ------- | -------------- |

{{SENTINEL_ADVISORIES}}

### Policy Failures

| Policy | Enforcement | Failure Reason | Remediation |
| ------ | ----------- | -------------- | ----------- |

{{SENTINEL_FAILURES}}

### Compliance Status

| Metric                       | Value                  |
| ---------------------------- | ---------------------- |
| **Total Policies Evaluated** | {{POLICY_TOTAL}}       |
| **Policies Passed**          | {{POLICY_PASSED}}      |
| **Advisory Warnings**        | {{POLICY_WARNINGS}}    |
| **Hard Failures**            | {{POLICY_FAILED}}      |
| **Compliance Rate**          | {{POLICY_COMPLIANCE}}% |

---

## Deployment Timeline

### Execution Phases

| Phase | Start Time | End Time | Duration | Status | Notes |
| ----- | ---------- | -------- | -------- | ------ | ----- |

{{TIMELINE_TABLE}}

### Critical Events

{{CRITICAL_EVENTS}}

---

## Infrastructure Outputs

### Deployed Resources

| Resource Type | Resource Name | Identifier | Status |
| ------------- | ------------- | ---------- | ------ |

{{RESOURCES_TABLE}}

### Terraform Outputs

```hcl
{{TERRAFORM_OUTPUTS}}
```

### Output Values

| Output Name | Value | Sensitive | Description |
| ----------- | ----- | --------- | ----------- |

{{OUTPUTS_TABLE}}

---

## Testing & Validation Results

### Pre-Deployment Testing

| Test Type              | Status             | Details                    |
| ---------------------- | ------------------ | -------------------------- |
| **Terraform Validate** | {{TEST_VALIDATE}}  | {{TEST_VALIDATE_DETAILS}}  |
| **Terraform Plan**     | {{TEST_PLAN}}      | {{TEST_PLAN_DETAILS}}      |
| **Pre-commit Hooks**   | {{TEST_PRECOMMIT}} | {{TEST_PRECOMMIT_DETAILS}} |
| **Static Analysis**    | {{TEST_STATIC}}    | {{TEST_STATIC_DETAILS}}    |

### Post-Deployment Validation

| Validation                | Status                  | Details                  |
| ------------------------- | ----------------------- | ------------------------ |
| **Resource Health Check** | {{HEALTH_STATUS}}       | {{HEALTH_DETAILS}}       |
| **Connectivity Tests**    | {{CONNECTIVITY_STATUS}} | {{CONNECTIVITY_DETAILS}} |
| **Integration Tests**     | {{INTEGRATION_STATUS}}  | {{INTEGRATION_DETAILS}}  |
| **Smoke Tests**           | {{SMOKE_STATUS}}        | {{SMOKE_DETAILS}}        |

---

## Cost Analysis

### Estimated Monthly Costs

| Service | Resource Count | Estimated Cost | Notes |
| ------- | -------------- | -------------- | ----- |

{{COST_BREAKDOWN_TABLE}}

**Total Estimated Monthly Cost**: {{TOTAL_MONTHLY_COST}}

### Cost Optimization Recommendations

{{COST_OPTIMIZATION}}

---

## Lessons Learned

### What Went Well ✅

{{LESSONS_SUCCESS}}

### Challenges Encountered ⚠️

{{LESSONS_CHALLENGES}}

### Improvements for Next Time 💡

{{LESSONS_IMPROVEMENTS}}

---

## Next Steps

### Immediate Actions Required

{{NEXT_IMMEDIATE}}

### Follow-up Tasks

{{NEXT_FOLLOWUP}}

### Future Enhancements

{{NEXT_ENHANCEMENTS}}

---

## Appendix

### A. Deployment Logs

#### Terraform Apply Log

```
{{TERRAFORM_APPLY_LOG}}
```

#### Terraform Plan Output

```
{{TERRAFORM_PLAN_OUTPUT}}
```

### B. Configuration Files

#### workspace.auto.tfvars

```hcl
{{WORKSPACE_TFVARS}}
```

#### backend Configuration

```hcl
{{BACKEND_CONFIG}}
```

### C. Error Messages & Stack Traces

{{ERROR_LOGS}}

### D. Environment Variables

```bash
{{ENV_VARS}}
```

---

## Report Metadata

| Attribute                    | Value                                    |
| ---------------------------- | ---------------------------------------- |
| **Report Generated**         | {{GENERATION_TIMESTAMP}}                 |
| **Report Version**           | {{REPORT_VERSION}}                       |
| **Generated By**             | Claude Code (claude-sonnet-4-6) |
| **Report ID**                | `{{REPORT_ID}}`                          |
| **Feature Directory**        | `{{FEATURE_DIR}}`                        |
| **Report Location**          | `{{REPORT_PATH}}`                        |
| **Deployment Environment**   | {{DEPLOY_ENV}}                           |
| **Terraform Workspace Type** | {{WORKSPACE_TYPE}}                       |

---

**Deployment Report Complete**

This report provides a comprehensive overview of the Terraform deployment process, including all successes, failures, workarounds, and security considerations. Use this document for audit trails, compliance verification, and future reference.

**Document Status**: {{DOC_STATUS}}
**Next Review Date**: {{NEXT_REVIEW}}
**Document Owner**: {{DOC_OWNER}}
