# Provider Resource Design: {provider}_{service}_{resource}

**Branch**: feat/{name}
**Date**: {YYYY-MM-DD}
**Status**: Draft | Approved | Implementing | Complete
**Provider**: {provider}
**Go Version**: >= {version}
**Plugin Framework**: >= {version}

---

## Table of Contents

1. [Purpose & Requirements](#1-purpose--requirements)
2. [Schema Design](#2-schema-design)
3. [CRUD Operations](#3-crud-operations)
4. [State Management & Error Handling](#4-state-management--error-handling)
5. [Test Scenarios](#5-test-scenarios)
6. [Implementation Checklist](#6-implementation-checklist)
7. [Open Questions](#7-open-questions)

---

## 1. Purpose & Requirements

{One paragraph. What infrastructure this resource manages, who consumes it,
what problem it solves. No implementation details beyond identifying the API/SDK.}

**Scope boundary**: {What is explicitly OUT of scope -- prevents scope creep.}

### Requirements

**Functional requirements** -- what the resource must do (from Phase 1 clarification):

- {Testable statement of required capability}
- ...

**Non-functional requirements** -- constraints like API compatibility, performance, availability:

- {Constraint or quality attribute that bounds the design}
- ...

{Requirements bridge Purpose and Schema Design. They are testable and unambiguous.
Frame capabilities in terms of outcomes, not Go implementation details.}

---

## 2. Schema Design

### Architectural Decisions

{Each decision as a paragraph with this structure:}

**{Decision title}**: {What was chosen}.
_Rationale_: {Why, with API/SDK or Plugin Framework documentation citation}.
_Rejected_: {What was considered and why it was rejected}.

### Schema Attributes

| Attribute | Go Type | Required/Optional/Computed | ForceNew | Default | Validators | Sensitive | Plan Modifiers | Description |
|-----------|---------|----------------------------|----------|---------|------------|-----------|----------------|-------------|
| `id` | `types.String` | Computed | -- | -- | -- | No | `UseStateForUnknown()` | Resource identifier |
| `{name}` | `{types.*}` | {R/O/C} | {Yes/No/--} | {value or --} | {validator or --} | {Yes/No} | {modifier or --} | {description} |

{This table is the SINGLE SOURCE OF TRUTH for the resource's schema.
Every attribute appears exactly once. Use types.* Go types, not raw Go types.}

### Nested Blocks

| Block Name | Nesting Mode | Min/Max Items | Attributes | Description |
|------------|-------------|---------------|------------|-------------|
| `{name}` | `SingleNestedAttribute` / `ListNestedAttribute` / `SetNestedAttribute` | {min}/{max or --} | {attribute list} | {description} |

{Include only if the resource has nested blocks. Omit this sub-section if none.}

---

## 3. CRUD Operations

### Create

- **API call**: `{SDK method name}` with `{InputType}`
- **Key mapping**: {How plan attributes map to API input fields}
- **Post-create**: {Any additional API calls needed after creation (e.g., tagging, waiting for status)}
- **State**: Set all Computed attributes from API response

### Read

- **API call**: `{SDK method name}` via finder function `find{Resource}ByID`
- **NotFound handling**: Remove from state via `resp.State.RemoveResource(ctx)`
- **State refresh**: Update all attributes from API response

### Update

- **Mutable attributes**: {List of attributes that can be updated in-place}
- **API call**: `{SDK method name}` with `{InputType}`
- **Conditional updates**: {Which attribute changes trigger which API calls}
- **State**: Refresh all attributes after update

### Delete

- **API call**: `{SDK method name}` with `{InputType}`
- **NotFound handling**: Silently succeed (resource already gone)
- **Wait**: {If deletion is async, describe the wait condition}

### Import

- **Import ID format**: `{format}` (e.g., `resource-id`, `service/resource-name`)
- **Import method**: `resource.ImportStatePassthroughID` or custom import logic
- **Post-import Read**: Standard Read operation refreshes all attributes

### Timeouts

| Operation | Default | Configurable |
|-----------|---------|:---:|
| Create | {duration} | {Yes/No} |
| Update | {duration} | {Yes/No} |
| Delete | {duration} | {Yes/No} |

---

## 4. State Management & Error Handling

### Finder Functions

| Function | Purpose | NotFound Behavior |
|----------|---------|-------------------|
| `find{Resource}ByID` | Look up resource by ID | Return `retry.NotFoundError` |
| `find{Resource}ByName` | Look up resource by name (if applicable) | Return `retry.NotFoundError` |

### Status Functions

| Function | Purpose | States |
|----------|---------|--------|
| `status{Resource}` | Poll resource status | {list of possible states: CREATING, ACTIVE, DELETING, etc.} |

{Include only if the resource has async operations. Omit if all operations are synchronous.}

### Waiter Functions

| Function | Pending States | Target States | Timeout |
|----------|---------------|---------------|---------|
| `wait{Resource}Created` | {CREATING, PENDING} | {ACTIVE, AVAILABLE} | {duration} |
| `wait{Resource}Deleted` | {DELETING} | {NOT_FOUND} | {duration} |

{Include only if the resource has async operations. Omit if all operations are synchronous.}

### Error Handling

| Error Type | Operation(s) | Handling | User Message |
|------------|-------------|----------|--------------|
| NotFound | Read, Delete | Remove from state / silently succeed | `"{Resource} {id} not found, removing from state"` |
| Conflict | Create, Update | Return error with conflict details | `"Error {verb}ing {Resource}: conflict"` |
| Throttle | All | SDK automatic retry | -- (SDK handles) |
| Validation | Create, Update | Return attribute error | `"Invalid {attribute}: {reason}"` |
| {API-specific error} | {operation} | {handling} | {message} |

{Rules:

- Error messages MUST NOT contain sensitive data (API keys, tokens, passwords)
- All error paths MUST add diagnostics -- no swallowed errors
- NotFound in Read MUST remove from state, not error
- NotFound in Delete MUST silently succeed}

---

## 5. Test Scenarios

{Six scenario groups are required: Basic, Disappears, Full Features, Update, Validation, and Error Handling.}

### Test Strategy

- **Test framework**: `terraform-plugin-testing` with `resource.ParallelTest`
- **Provider factories**: `acctest.ProtoV5ProviderFactories`
- **Resource naming**: `sdkacctest.RandomWithPrefix(acctest.ResourcePrefix)`
- **Cleanup**: `CheckDestroy` function + sweep function for leaked resources
- **Environment**: `TF_ACC=1` required, additional env vars as needed for API credentials

### Scenario: Basic

**Purpose**: Verify resource creation with minimal configuration and import
**Test function**: `TestAcc{Resource}_basic`

**Config function(s)**:

- `testAcc{Resource}Config_basic(rName string) string`

**Check functions**:

- `testAccCheck{Resource}Exists(ctx, resourceName)`
- `resource.TestCheckResourceAttr(resourceName, "{attr}", "{value}")`
- `resource.TestCheckResourceAttrSet(resourceName, "{computed_attr}")`

**Steps**:

1. Create with basic config → verify exists + attributes
2. ImportState → verify import works

### Scenario: Disappears

**Purpose**: Verify graceful handling when resource is deleted outside Terraform
**Test function**: `TestAcc{Resource}_disappears`

**Config function(s)**:

- `testAcc{Resource}Config_basic(rName string) string`

**Check functions**:

- `testAccCheck{Resource}Exists(ctx, resourceName)`
- `acctest.CheckResourceDisappears(ctx, acctest.Provider, Resource{Resource}(), resourceName)`

**Steps**:

1. Create → verify exists → delete outside Terraform → expect non-empty plan

### Scenario: Full Features

**Purpose**: Verify all optional attributes set and all features enabled
**Test function**: `TestAcc{Resource}_fullFeatures`

**Config function(s)**:

- `testAcc{Resource}Config_fullFeatures(rName string) string`

**Check functions**:

- `testAccCheck{Resource}Exists(ctx, resourceName)`
- `resource.TestCheckResourceAttr(resourceName, "{attr}", "{value}")` for each optional attribute

**Steps**:

1. Create with all features → verify all attributes

### Scenario: Update

**Purpose**: Verify in-place update of mutable attributes
**Test function**: `TestAcc{Resource}_update`

**Config function(s)**:

- `testAcc{Resource}Config_basic(rName string) string`
- `testAcc{Resource}Config_updated(rName string) string`

**Check functions**:

- Verify pre-update attributes
- Verify post-update attributes changed

**Steps**:

1. Create with initial config → verify attributes
2. Update to new config → verify attributes changed

### Scenario: Validation

**Purpose**: Verify invalid inputs are rejected
**Test function**: `TestAcc{Resource}_validation`

**Config function(s)**:

- `testAcc{Resource}Config_invalidName(rName string) string`
- ... (one per validation case)

**Steps**:

1. Apply invalid config → expect error matching `regexp.MustCompile("{error pattern}")`

### Scenario: Error Handling

**Purpose**: Verify API errors are handled gracefully
**Test function**: `TestAcc{Resource}_errorHandling`

{This scenario is optional if error handling is fully covered by other scenarios.
Include when specific API error conditions need dedicated testing.}

**Steps**:

- {Describe error conditions to test}

---

## 6. Implementation Checklist

- [ ] **A: Schema & test stubs** -- Create resource file with Schema, model struct, empty CRUD methods, and test stubs for all 6 scenario groups
- [ ] **B: Finder & helpers** -- Implement finder functions, status/waiter functions (if async), test helper functions (exists, destroy checks)
- [ ] **C: Create & Read** -- Implement Create and Read operations, wire to API, set state
- [ ] **D: Update & Delete** -- Implement Update and Delete operations, handle NotFound
- [ ] **E: Import** -- Implement ImportState, add import test step to basic test
- [ ] **F: Tests** -- Complete all test configs and check functions, verify test compilation
- [ ] **G: Documentation** -- `.html.markdown` docs with examples, changelog entry
- [ ] **H: Polish** -- `go build`, `go vet`, `gofmt`, fix all warnings

{Keep this to 4-8 items. Each item = one implementation pass.
NOT a fine-grained task breakdown. Each item should be completable in one agent turn.
Each item must have clear scope boundaries -- list which files it creates/modifies.
Items must not overlap: if A creates a file, B must not also create that file (but may modify it).}

---

## 7. Open Questions

{Any deferred decisions marked [DEFERRED] with context.
Empty section if all questions resolved during clarification.}

---

## Template Rules

1. No section may reference another section by line number
2. Attribute names appear exactly once -- in Schema Design (Section 2)
3. CRUD operations reference API methods, not schema attribute details
4. Each test scenario maps 1:1 to a test function with named config and check functions
5. Implementation checklist items are coarse-grained -- one per logical unit with explicit file scope
