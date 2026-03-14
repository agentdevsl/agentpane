# AgentPane Implementation Plan

## Executive Summary

Complete implementation plan for AgentPane - a local-first multi-agent task management system. All specifications are in `/specs/application/`. This plan breaks implementation into 5 phases with ~69 foundation tasks, 5 services, 29 API endpoints, 10 UI components, and 164+ test cases.

## Tech Stack

| Layer | Technology | Package | Version |
|-------|------------|---------|---------|
| Runtime | Bun | <https://bun.sh> | 1.3.10 |
| Framework | TanStack Start | @tanstack/react-start | 1.150.0 |
| Database | PGlite | @electric-sql/pglite | 0.3.15 |
| ORM | Drizzle | drizzle-orm + drizzle-kit | 0.45.1 |
| Client State | TanStack DB | @tanstack/db + @tanstack/react-db | 0.5.20 / 0.1.64 |
| Agent Events | Durable Streams | @durable-streams/client + @durable-streams/state | 0.1.5 |
| AI / Agents | Claude Agent SDK | @anthropic-ai/claude-agent-sdk | 0.2.9 |
| UI | Radix + Tailwind | @radix-ui/* + tailwindcss | 1.2.4 / 4.1.18 |
| Drag & Drop | dnd-kit | @dnd-kit/core + @dnd-kit/sortable | 6.3.1 |
| Testing | Vitest | vitest | 4.0.17 |
| UI Testing | Agent Browser | agent-browser | 0.5.0 |
| Linting/Formatting | Biome | @biomejs/biome | 2.3.11 |

## Implementation Phases

| Phase | Duration | Description | Document |
|-------|----------|-------------|----------|
| Phase 1 | Weeks 1-3 | Foundation Layer | [phase-1-foundation.md](./phase-1-foundation.md) |
| Phase 2 | Weeks 3-5 | Services Layer | [phase-2-services.md](./phase-2-services.md) |
| Phase 3 | Weeks 5-6 | API Layer | [phase-3-api.md](./phase-3-api.md) |
| Phase 4 | Weeks 6-8 | UI Layer | [phase-4-ui.md](./phase-4-ui.md) |
| Phase 5 | Parallel | Testing | [phase-5-testing.md](./phase-5-testing.md) |

## Task Breakdown

See [tasks.md](./tasks.md) for the complete task breakdown with dependencies and estimates.

## Timeline

```
Week 1-2: Foundation (utilities, database, errors)
Week 2-3: Foundation (bootstrap, state machines, config)
Week 3-4: Services (WorktreeService, ProjectService, TaskService)
Week 4-5: Services (SessionService, AgentService)
Week 5-6: API (29 endpoints)
Week 6-7: UI (primitives, feature components)
Week 7-8: UI (page routes, real-time integration)
Parallel: Testing (unit, integration, E2E)
```

**Total: 8 weeks**

## Critical Path

```
Result type → Error types → Database Schema → PGlite Client
                                    ↓
                           Bootstrap Service
                                    ↓
                    WorktreeService → TaskService
                                    ↓
                    SessionService → AgentService
                                    ↓
                           API Endpoints
                                    ↓
                    UI Primitives → Feature Components
                                    ↓
                           Page Routes + Loaders
                                    ↓
                           E2E Test Suite
```

## Key Specification Files

| Spec | Path |
|------|------|
| Overview | `/specs/application/README.md` |
| Database | `/specs/application/database/schema.md` |
| Bootstrap | `/specs/application/architecture/app-bootstrap.md` |
| State Machines | `/specs/application/state-machines/*.md` |
| Services | `/specs/application/services/*.md` |
| API | `/specs/application/api/endpoints.md` |
| Components | `/specs/application/components/*.md` |
| Integrations | `/specs/application/integrations/*.md` |
| Testing | `/specs/application/testing/*.md` |
| Errors | `/specs/application/errors/error-catalog.md` |

## Development Guidelines

See `/AGENTS.md` for:

- Coding standards (MUST/NEVER/PREFER rules)
- TypeScript strict mode requirements
- TDD approach
- Error handling patterns
- Local-first architecture
