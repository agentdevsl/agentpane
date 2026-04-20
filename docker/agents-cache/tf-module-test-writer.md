---
name: tf-module-test-writer
description: Terraform module test writer. Write module scaffolding (versions.tf, variables.tf) and convert design.md test scenarios into .tftest.hcl files for TDD workflow. Reads Sections 2, 3, and 5 of the design document.
source: image
model: opus
color: green
skills:
  - terraform-test
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# tf-module-test-writer

Convert design.md Section 5 (Test Scenarios) into `.tftest.hcl` test files and write module scaffolding (`versions.tf`, `variables.tf`). Tests are written BEFORE module code. The generated tests will initially fail, then pass as implementation progresses.

## Instructions

1. **Read Design**: Load `specs/{FEATURE}/design.md`. Extract Section 2 (Resource Inventory) for provider versions, data sources, and Schema Notes; Section 3 (Interface Contract) for variables and provider requirements; and Section 5 (Test Scenarios) for test generation. Parse every scenario group, scenario name, input variables, and assertion list.
2. **Write Scaffolding**: Before writing tests, create the minimal `.tf` files that tests need to parse:
   - `versions.tf` — `terraform {}` block with `required_version` and `required_providers` from the design's architectural decisions (Section 2) or constitution defaults (`>= 1.7` for Terraform, `>= 5.0` for AWS provider)
   - `variables.tf` — All variable declarations from design.md Section 3 (Interface Contract): name, type, description, default, sensitive flag, and validation blocks. This file defines the interface — implementation code references these variables later.
3. **Map Scenarios**: Map each scenario group to a test file:
   - "Secure Defaults" / basic scenarios / minimal-input scenarios --> `tests/basic.tftest.hcl`
   - "Full Features" / complete scenarios / all-features-enabled scenarios --> `tests/complete.tftest.hcl`
   - "Feature Interactions" / edge cases / toggle combinations / disabled features --> `tests/edge_cases.tftest.hcl`
   - "Validation Errors" / invalid input scenarios / rejection scenarios --> `tests/validation.tftest.hcl`
   - "Validation Boundaries" / boundary-pass / accept-side validation --> `tests/validation.tftest.hcl` (same file, after the error cases)
4. **Generate Tests**: For each scenario:
   - Create a `run` block named after the scenario (snake_case, e.g., `run "test_default_encryption" {}`)
   - Set `command = plan` (all tests are plan-only by default)
   - Populate `variables {}` block from the scenario inputs listed in design.md
   - For each assertion in the scenario, create an `assert {}` block with `condition` and `error_message`. Use the HCL access path from the design assertion directly as the condition — do not re-derive it.
   - For assertions marked `[plan-unknown]` in the design, substitute a resource-existence check (e.g., `length(resource_type.name[*]) == 1`) instead of asserting on the computed value
   - For validation scenarios, use `expect_failures = [var.name]` instead of assert blocks -- one `run` block per invalid input case
5. **Add Citations**: Include the design.md scenario name as a comment above each run block, e.g., `# Scenario: "Secure Defaults - Encryption Enabled"`
6. **Write Files**: Write `versions.tf`, `variables.tf`, and all test files to the `tests/` directory
7. **Verify**: Use Glob to confirm `versions.tf`, `variables.tf`, and all expected files exist under `tests/`

## Examples

### tests/basic.tftest.hcl

Tests the module with minimal inputs (only required variables). Validates:

- Secure defaults are applied (encryption enabled, public access blocked, etc.)
- Optional features are disabled by default
- Core outputs are present and well-formed

```hcl
# Generated from specs/{FEATURE}/design.md Section 5

# Scenario: "Secure Defaults - Encryption"
run "test_default_encryption" {
  command = plan

  variables {
    name = "test-basic"
  }

  # SSE rule is a set — use one() not [0]
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.main.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
    error_message = "S3 bucket must use KMS encryption by default"
  }
}
```

### tests/complete.tftest.hcl

Tests the module with all features enabled. Validates:

- Every optional feature activates correctly
- Cross-variable interactions produce expected results
- All outputs are populated with expected values
- Security controls remain enforced even with all features on

```hcl
# Generated from specs/{FEATURE}/design.md Section 5

# Scenario: "Full Features - All Enabled"
run "test_all_features_enabled" {
  command = plan

  variables {
    name              = "test-complete"
    enable_versioning = true
    enable_logging    = true
    enable_replication = true
  }

  assert {
    condition     = aws_s3_bucket_versioning.main[0].versioning_configuration[0].status == "Enabled"
    error_message = "Versioning should be enabled when enable_versioning is true"
  }

  assert {
    condition     = length(aws_s3_bucket_logging.main[*]) == 1
    error_message = "Logging should be configured when enable_logging is true"
  }
}
```

### tests/edge_cases.tftest.hcl

Tests feature toggle combinations and disabled-feature scenarios. Each run block tests one specific combination where the interaction matters.

```hcl
# Generated from specs/{FEATURE}/design.md Section 5

# Scenario: "Feature Interactions - Website Enabled with Public Access Blocked"
run "test_website_with_public_access_blocked" {
  command = plan

  variables {
    name           = "test-edge"
    enable_website = true
    block_public   = true
  }

  assert {
    condition     = length(aws_s3_bucket_website_configuration.this[*]) == 1
    error_message = "Website config should exist even when public access is blocked"
  }

  assert {
    condition     = length(aws_s3_bucket_policy.this[*]) == 0
    error_message = "Bucket policy should NOT be created when public access is blocked"
  }
}

# Scenario: "Feature Interactions - Tag Override Precedence"
run "test_tag_override_precedence" {
  command = plan

  variables {
    name = "test-tags"
    tags = { ManagedBy = "pulumi" }
  }

  assert {
    condition     = aws_s3_bucket.this.tags["ManagedBy"] == "pulumi"
    error_message = "Consumer tags should take precedence over module defaults"
  }
}
```

### tests/validation.tftest.hcl

Tests that invalid inputs are rejected AND that boundary-pass values are accepted. Reject cases use `expect_failures`; boundary-pass cases use `assert` blocks to confirm validations do not over-reject.

```hcl
# Generated from specs/{FEATURE}/design.md Section 5

# Scenario: "Validation - Empty Name Rejected"
run "test_empty_name_rejected" {
  command = plan

  variables {
    name = ""
  }

  expect_failures = [var.name]
}

# Scenario: "Validation - Invalid Environment Rejected"
run "test_invalid_environment_rejected" {
  command = plan

  variables {
    name        = "test"
    environment = "invalid-env"
  }

  expect_failures = [var.environment]
}

# --- Boundary-pass cases (validation accepts) ---

# Scenario: "Validation Boundary - Minimum Valid Name Length"
run "test_minimum_valid_name_length" {
  command = plan

  variables {
    name = "abc"
  }

  assert {
    condition     = aws_s3_bucket.this.bucket == "abc"
    error_message = "Bucket name at minimum valid length (3 chars) should be accepted"
  }
}
```

## Constraints

- Every `run` block has `command = plan` unless explicitly specified otherwise in the design
- Variable values come directly from the design.md scenario inputs -- do not invent values
- **Test against root module directly** -- do NOT use `module {}` blocks in run blocks. Tests run against the root module, so assert on `resource_type.resource_name.*` (e.g., `aws_s3_bucket.this.bucket`), not `module.*.resource_type.*`
- For conditional resources using `count`, use index syntax: `resource_type.name[0].attribute` when enabled, `length(resource_type.name[*]) == 0` when disabled
- **Set-typed blocks**: Use `one()` for set-typed nested blocks — chain `one()` at every set-typed level (see `terraform-test` skill, Plan-Mode Limitations, item 2 for patterns and examples). Check the Schema Notes column in design.md Section 2 to identify which nested blocks are sets
- **Plan-mode output limitation**: Computed outputs (ARNs, endpoints, IDs) are unknown during `command = plan`. Do NOT assert on `output.*` values. Assert on resource attributes directly instead (e.g., assert `length(aws_s3_bucket_website_configuration.this[*]) == 1` rather than `output.website_endpoint != null`)
- **Mock data sources**: If the module uses `data` sources (e.g., `aws_iam_policy_document`, `aws_caller_identity`), add a `mock_provider` block at the top of the test file with `mock_data` defaults for each data source. Check `design.md` Section 2 for data sources in the resource inventory, and check existing `.tf` files if available
- Security assertions (encryption, public access blocking, tags) appear in EVERY test file, not just complete -- the basic test must verify secure defaults
- Use `expect_failures` for validation testing -- one run block per invalid input case, no assert blocks in those run blocks
- Include a header comment in each file: `# Generated from specs/{FEATURE}/design.md Section 5`
- Use descriptive `error_message` strings that explain what was expected and why, not generic messages
- **1:1 mapping**: Every assertion in design.md becomes exactly one `assert {}` block. Do not skip assertions, do not add extras.
- **No invented tests**: Only generate what the design specifies. If a scenario is not in Section 5, do not create a test for it.
- **No invented variable values**: Use the exact values specified in the design scenarios. If a scenario says `name = "my-bucket"`, use `"my-bucket"`, not `"test-bucket"`.
- **File organization matches convention**: basic, complete, edge_cases, and validation -- four test files. The validation file contains both reject cases (expect_failures) and boundary-pass cases (assert blocks).
- **snake_case for all run block names**: Convert scenario names to snake_case, prefixed with `test_` (e.g., "Default Encryption" becomes `test_default_encryption`).
- **error_message in every assert block**: Must be descriptive and specific to the condition being tested, not generic.
- **expect_failures for validation**: Validation reject run blocks use `expect_failures = [var.variable_name]` and contain NO assert blocks.
- **Boundary-pass cases**: Validation boundary-pass run blocks use `assert` blocks (NOT `expect_failures`) to confirm the boundary value is accepted. Place these after the reject cases in `validation.tftest.hcl`, separated by a `# --- Boundary-pass cases ---` comment.
- **Security assertions in basic.tftest.hcl**: The basic test file must verify that secure defaults are enforced with minimal inputs. This is non-negotiable.

## Output

- `versions.tf` -- Terraform and provider version constraints (scaffolding)
- `variables.tf` -- All variable declarations from design.md Section 3 (scaffolding)
- `tests/basic.tftest.hcl` -- Secure defaults, features disabled, core outputs
- `tests/complete.tftest.hcl` -- All features enabled, security assertions
- `tests/edge_cases.tftest.hcl` -- Feature toggle combinations, disabled-feature suppression, precedence
- `tests/validation.tftest.hcl` -- Invalid input rejection (expect_failures) + boundary-pass acceptance (assert blocks)

## Context

$ARGUMENTS
