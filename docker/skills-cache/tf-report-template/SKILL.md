---
name: "tf-report-template"
description: "Validation results summary template for Phase 4 output. Provides the format for reporting terraform test, validate, fmt, tflint, pre-commit, trivy, and security checklist results."
source: image
---
# Validation Results Report Template

Phase 4 output format. Report validation results only — no resource tracking, token usage, or workaround logs.

## Report Location

`specs/{FEATURE}/reports/validation_$(date +%Y%m%d-%H%M%S).md`

## Template

Select the relevent template based on the use case

- Module Template: `./template/tf-module-template.md`
- Provider Template: `./template/tf-provider-template.md`
- Terraform Consumer Template: `./template/tf-consumer-template.md`

## Rules

1. Replace all `{{PLACEHOLDERS}}` — use "N/A" if data is unavailable
2. Verify no `{{` remains before writing the final file
3. Keep the report under 80 lines — tables over prose
4. CRITICAL or HIGH trivy defects force overall FAIL — accepted risks with design.md justification do not count as defects
5. Any terraform test failure forces overall FAIL
6. Any security checklist failure forces overall FAIL

## PASS Criteria

All of the following must be true for overall PASS:

- All `terraform test` files pass
- `terraform validate` is clean
- `terraform fmt -check` reports no changes needed
- tflint reports no findings
- `pre-commit run --all-files` passes
- trivy reports 0 CRITICAL and 0 HIGH defects (accepted risks excluded)
- All security checklist controls pass
