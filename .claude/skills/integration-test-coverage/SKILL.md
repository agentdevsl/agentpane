---
name: integration-test-coverage
description: "Analyze codebases for integration test coverage gaps and write tests to fill them. Use this skill whenever the user asks to add integration tests, check test coverage, find untested code paths, audit test quality, or mentions phrases like 'what needs testing', 'test coverage gaps', 'missing tests', 'integration tests for', or 'test this service/API/module'. Also trigger when the user has just implemented a feature and hasn't written integration tests yet, or when reviewing code that crosses service/module boundaries."
---

# Integration Test Coverage

A systematic approach to identifying integration test coverage gaps and writing effective tests that verify how components work together across service boundaries, database operations, API endpoints, and state transitions.

## Why integration tests matter differently than unit tests

Unit tests verify isolated functions. Integration tests verify that independently-correct pieces actually work together — that the database schema matches what the ORM expects, that service A's output is valid input for service B, that API endpoints return what the frontend consumes. The bugs integration tests catch are the ones that slip through unit tests: schema drift, incorrect FK cascades, race conditions between services, state machine transitions that corrupt related records.

The goal is not 100% coverage — it's coverage of the *seams* where components meet. A single integration test covering a create-read-update-delete flow through real services and a real database catches more production bugs than twenty unit tests with mocked dependencies.

## Phase 1: Analyze the codebase

Before writing any tests, understand what exists and what's missing. This analysis phase is the foundation — rushing to write tests without it leads to redundant coverage and missed gaps.

### Step 1: Map the architecture

Identify the key layers and how they connect:

```
Read the project structure and identify:
- Services (business logic layer)
- API routes/controllers (HTTP layer)
- Database schema and ORM models (data layer)
- State machines or workflow engines
- External integrations (APIs, SDKs, message queues)
- Shared utilities that multiple services depend on
```

### Step 2: Inventory existing tests

Search for existing test files and categorize them:

```
For each service/module, determine:
- Does it have unit tests? (mocked dependencies)
- Does it have integration tests? (real DB, real service interactions)
- Does it have API-level tests? (HTTP request → response)
- What's tested vs what's not?
```

Build a coverage map — a mental model of which seams between components are tested and which aren't.

### Step 3: Identify gaps using the seam analysis method

Integration test gaps live at the boundaries between components. Systematically check each seam:

**Database seams** — Where code writes to or reads from the database:
- Schema matches ORM expectations (column names, types, defaults, nullability)
- Migrations produce the expected schema (not just "run without error")
- FK cascade behavior (ON DELETE CASCADE, SET NULL) works as the service expects
- Indexes exist for queries that services actually run
- Insert/update/select roundtrips preserve all fields

**Service-to-service seams** — Where one service calls another:
- Service A's return type matches what Service B expects as input
- Error propagation: when Service A fails, does Service B handle it correctly?
- State consistency: if Service A updates a record, does Service B see the update?
- Transaction boundaries: do multi-service operations roll back correctly on failure?

**API-to-service seams** — Where HTTP handlers call services:
- Request validation accepts valid input and rejects invalid input
- Response shape matches what the client/frontend expects
- Error responses have correct status codes and error bodies
- Auth/RBAC checks run before service calls
- Pagination, filtering, sorting work end-to-end

**State machine seams** — Where state transitions trigger side effects:
- Each valid transition produces the expected state and side effects
- Invalid transitions are rejected (not silently ignored)
- Concurrent transitions don't corrupt state
- Side effects (events emitted, related records updated) actually fire

**Event/message seams** — Where events are published and consumed:
- Published events have the expected shape
- Consumers handle all event types they're subscribed to
- Event ordering assumptions hold under concurrent publishing

### Step 4: Prioritize gaps

Not all gaps are equally important. Prioritize by:

1. **Data integrity** — Gaps where bugs could corrupt or lose data (highest priority)
2. **User-facing flows** — Gaps in critical user workflows (create, update, delete operations)
3. **Cross-service coordination** — Gaps where multiple services must agree on state
4. **Edge cases in existing coverage** — Happy path is tested but error paths aren't
5. **Recently changed code** — New features or refactors that haven't been tested yet

### Step 5: Present the gap analysis

Before writing any tests, present findings to the user as a structured report:

```markdown
## Integration Test Coverage Analysis

### Coverage Map
| Module/Service | Unit Tests | Integration Tests | API Tests | Gaps |
|---------------|-----------|------------------|-----------|------|
| UserService   | 12 tests  | 3 tests          | 5 tests   | Delete cascade, batch update |
| TaskService   | 8 tests   | 0 tests          | 2 tests   | State transitions, concurrency |

### Priority Gaps (ranked by risk)
1. **[Critical]** TaskService state machine — no integration test for concurrent column moves
2. **[High]** Session cascade delete — FK constraints not tested with real DB
3. **[Medium]** API pagination — only tested with mocked data, not real queries

### Recommended Tests (N tests)
- Test 1: description, covers gap X
- Test 2: description, covers gap Y
```

Wait for user confirmation before proceeding to write tests.

## Phase 2: Write integration tests

### Principles for effective integration tests

**Test real interactions, not mocks.** The whole point of integration tests is verifying that real components work together. Use a real database (in-memory SQLite, test PostgreSQL, etc.), real service instances, and real ORM queries. Only mock at the outermost boundary — external HTTP APIs, file systems, third-party SDKs.

**One test, one scenario, multiple assertions.** Each test should walk through a realistic scenario (create a user, assign a task, move the task, verify the state). Multiple assertions within that scenario are fine — they're all verifying aspects of the same integration point. But don't cram unrelated scenarios into one test.

**Set up with factories, not raw SQL.** Use the project's factory/builder pattern to create test data. This ensures test data matches the schema and makes tests readable. If the project has factories (like `createTestProject()`, `createTestUser()`), use them. If not, create reusable helper functions.

**Clean up between tests.** Each test must start from a known state. Use `beforeEach`/`afterEach` hooks to set up and tear down the database. Never depend on test execution order.

**Name tests by what they verify.** Good: `"cascade-deletes project's tasks and sessions when project is deleted"`. Bad: `"test delete"`. The name should tell you what broke when the test fails.

### Test structure template

Follow the project's existing test patterns. If the project uses Vitest:

```typescript
describe('Feature: [what integration point]', () => {
  // Setup/teardown matching project conventions

  it('[action] [expected outcome] when [condition]', async () => {
    // Arrange — create test data using factories
    // Act — perform the operation through real services
    // Assert — verify the outcome in the database/response/state
  });
});
```

### What to assert in integration tests

- **Database state**: Query the DB after the operation and verify records exist/changed/deleted
- **Return values**: Verify the service/API returns the expected shape and data
- **Side effects**: Check that related records were updated, events were emitted, caches were invalidated
- **Error behavior**: Verify that invalid operations return proper error types/codes, not unhandled exceptions
- **Constraint enforcement**: Verify that uniqueness, FK, and check constraints are enforced

### Adapt to the project's testing stack

Read the project's test configuration and existing tests to match:
- **Test runner**: Vitest, Jest, Mocha, etc.
- **Database setup**: In-memory SQLite, test containers, transaction rollback
- **Factory/fixture pattern**: Builder functions, factory libraries, raw inserts
- **Assertion style**: `expect()`, `assert()`, custom matchers
- **File organization**: Co-located (`__tests__/`), separate (`tests/`), by type (`tests/integration/`)
- **Naming conventions**: `*.test.ts`, `*.spec.ts`, `*.integration.test.ts`

Do not impose a testing pattern that conflicts with the project's existing conventions. If the project uses `describe`/`it` with `expect`, use that. If it uses a factory pattern, follow it. Consistency with the existing codebase matters more than any "best practice" in isolation.

### Common integration test categories to write

**CRUD lifecycle tests** — Create, read, update, delete through real services with real DB:
```
Create → verify in DB → update → verify change → delete → verify gone
```

**Cascade and referential integrity tests** — Delete a parent and verify children are handled:
```
Create parent + children → delete parent → verify children deleted/nullified per FK rules
```

**Cross-service workflow tests** — Operations that span multiple services:
```
Service A creates → Service B reads and modifies → verify both services see consistent state
```

**State transition tests** — Valid and invalid state machine transitions:
```
Create in state A → transition to B (valid) → verify side effects → attempt invalid transition → verify rejection
```

**Concurrency tests** — Parallel operations on the same resource:
```
Start two operations concurrently → verify no data corruption, proper error for loser
```

**API contract tests** — HTTP request through real handler to real service:
```
Send HTTP request → verify response status, shape, headers → verify DB side effects
```

**Error propagation tests** — Failures at one layer surface correctly at another:
```
Cause a service error → verify API returns correct error code and message
```

**Migration/schema drift tests** — Database schema matches what code expects:
```
Run migrations → compare actual schema columns with ORM model definition
```

## Phase 3: Verify and iterate

After writing tests:

1. **Run the tests** to verify they pass
2. **Check for flakiness** — run twice; if results differ, fix the non-determinism
3. **Review test quality**:
   - Does each test actually exercise the integration point? (not just re-testing unit logic)
   - Are assertions checking the right things? (DB state, not implementation details)
   - Would the test catch a real bug? (if you broke the integration, would this test fail?)
4. **Report what was covered** — update the coverage map for the user

## Anti-patterns to avoid

- **Mock everything**: If you're mocking the database in an integration test, it's a unit test in disguise. Use a real (test) database.
- **Testing implementation details**: Don't assert on internal method calls or private state. Assert on observable outcomes (DB records, API responses, emitted events).
- **Fragile setup**: If adding a column to the schema breaks 50 integration tests, the setup is too coupled. Use factories that adapt to schema changes.
- **No cleanup**: Tests that leave data behind cause cascading failures. Always clean up, even if a test fails (use `afterEach`, not manual cleanup at end of test).
- **Testing the framework**: Don't write integration tests for your ORM's basic operations or your HTTP framework's routing. Test *your* code's use of these tools.
- **Ignoring error paths**: Happy-path-only integration tests miss the most dangerous bugs. Always include error scenarios.
- **Sequential dependency**: Tests that must run in a specific order are fragile. Each test should set up its own state from scratch.
