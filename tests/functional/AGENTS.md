# Functional Tests — Mocking & Real Service Discipline

## Single Rule

Every state transition must flow through real service code.

## Allowed Mock Boundaries

| Boundary | Why | Preferred helper |
| --- | --- | --- |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | External API | `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` |
| Sandbox providers (Docker, Kubernetes, AgentCore) | External daemon | Stub provider factory |
| `CommandRunner` | Host shell and git side effects | `{ exec: vi.fn(), execArgs: vi.fn() }` |
| Durable Streams server | Caddy-side process | In-memory stream server |
| Settings reads when not under test | Cross-cutting configuration | Narrow settings-service mock |

## Forbidden Patterns

1. Do not mock `TaskService`, `SessionService`, `WorktreeService`, `PlanApprovalService`, `SandboxStateManager`, or `AgentService` in functional tests. These are the behavior under test.
2. Do not simulate lifecycle transitions with direct `db.update(tasks).set({ column: ... })`; call the service method that owns the transition.
3. Do not directly insert `session_events` to simulate publishing; call `sessionService.publish()`.
4. Do not leave module-level mock implementations in place across tests; reset implementations with `mockReset()` when a file-scope mock is unavoidable.
5. Do not use stream mocks that silently accept any payload when the test depends on stream shape or offsets.
6. Do not swallow expected failures with bare `catch {}` blocks; assert the expected error code or condition.

## Allowed Fixture Writes

- `db.insert(settings)` for sandbox or agent runtime configuration. Mark it with `// TEST-SETUP:`.
- Direct FK precondition rows when the test is not about that service. Prefer factories when available.
- `execRawSql('PRAGMA foreign_keys = ON')` only when the test is explicitly verifying database enforcement.

## Assertion Contract

For lifecycle tests, assert both the service result and the persisted state. For plan or running-agent flows, also assert `SandboxStateManager` memory state when the test creates one.

Concurrency tests in the default SQLite functional project are protocol tests, not proof of production transaction semantics. Semantic concurrency coverage belongs in a Postgres-backed integration test.
