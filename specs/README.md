# AgentPane Specifications — Master Index

## Status Dashboard

| Area | Spec Coverage | Status |
|------|--------------|--------|
| Database (36 tables) | Full | Updated |
| API Routes (33 modules, 60+ endpoints) | Full | Updated |
| Services (25+) | 9 documented | Partial |
| State Machines (4) | Full | Updated |
| UI Components (19 spec'd) | Full | Current |
| Integrations (6) | Full | Updated |
| Security (4) | Full | Updated |
| Architecture Diagrams (9) | Full | New |
| Wireframes (20 HTML) | Full | Current |

---

## Directory Structure

```
specs/
├── README.md                          # This file — master index
│
├── application/                       # Core application specs (source of truth)
│   ├── README.md                      # Spec overview and document tree
│   ├── user-stories.md                # 23 user stories with acceptance criteria
│   │
│   ├── api/                           # REST API (60+ endpoints)
│   │   ├── endpoints.md               # All API endpoints (Hono-based)
│   │   └── pagination.md              # Pagination patterns
│   │
│   ├── architecture/                  # System Architecture
│   │   └── app-bootstrap.md           # 6-phase initialization
│   │
│   ├── components/                    # UI Component Specifications (19)
│   │   ├── agent-config-dialog.md
│   │   ├── agent-session-view.md
│   │   ├── approval-dialog.md
│   │   ├── breadcrumbs.md
│   │   ├── empty-states.md
│   │   ├── error-state.md
│   │   ├── form-inputs.md
│   │   ├── github-app-setup.md
│   │   ├── kanban-board.md
│   │   ├── loading-skeletons.md
│   │   ├── new-project-dialog.md
│   │   ├── project-picker.md
│   │   ├── project-settings.md
│   │   ├── queue-waiting-state.md
│   │   ├── session-history.md
│   │   ├── task-detail-dialog.md
│   │   ├── theme-toggle.md
│   │   ├── toast-notifications.md
│   │   └── worktree-management.md
│   │
│   ├── configuration/
│   │   └── config-management.md       # Project config, env vars
│   │
│   ├── database/
│   │   └── schema.md                  # Drizzle ORM schema (36 tables, SQLite + PostgreSQL)
│   │
│   ├── errors/
│   │   └── error-catalog.md           # 44 error codes with HTTP mappings
│   │
│   ├── implementation/
│   │   ├── README.md
│   │   ├── animation-system.md
│   │   ├── component-patterns.md      # CVA, Radix patterns
│   │   └── mobile-responsive.md
│   │
│   ├── integrations/
│   │   ├── caddy.md                   # Caddy reverse proxy
│   │   ├── claude-agent-sdk.md        # Claude Agent SDK (v0.2.19)
│   │   ├── durable-sessions.md        # Durable Streams (v0.2.0)
│   │   ├── git-worktrees.md           # Git worktree isolation
│   │   ├── github-app.md              # GitHub OAuth + webhooks
│   │   └── terraform-registry.md      # Terraform No-Code Composer
│   │
│   ├── operations/
│   │   ├── deployment.md              # Docker, CI/CD
│   │   └── monitoring.md              # Logging, metrics
│   │
│   ├── routing/
│   │   └── routes.md                  # TanStack Router (all frontend routes)
│   │
│   ├── security/
│   │   ├── authentication.md          # OAuth, sessions, API tokens
│   │   ├── rbac.md                    # Role-based access control
│   │   ├── sandbox.md                 # Container isolation
│   │   └── security-model.md          # Tool sandbox, audit logging
│   │
│   ├── services/
│   │   ├── agent-service.md           # Agent lifecycle (planning, execution, queue)
│   │   ├── cli-monitor-service.md     # CLI monitor package
│   │   ├── container-agent-service.md # Docker container agent execution
│   │   ├── event-service.md           # Event sources, subscriptions, processing
│   │   ├── project-service.md         # Project CRUD and config
│   │   ├── scheduler-service.md       # Task scheduling and cron
│   │   ├── session-service.md         # Session management (7 states)
│   │   ├── task-service.md            # Task workflow (5 columns)
│   │   └── worktree-service.md        # Git worktree operations
│   │
│   ├── state-machines/
│   │   ├── agent-lifecycle.md         # 7 states: idle → planning → completed
│   │   ├── session-lifecycle.md       # 7 states: idle → closed
│   │   ├── task-workflow.md           # 5 columns: backlog → verified
│   │   └── worktree-lifecycle.md      # 6 states: creating → removed
│   │
│   ├── testing/
│   │   ├── test-cases.md              # 164+ test case definitions
│   │   └── test-infrastructure.md     # Mocks, factories, CI setup
│   │
│   └── wireframes/                    # Visual Designs (20 HTML files)
│       ├── design-tokens.css
│       └── *.html
│
├── sandbox/                           # Deep sandbox architecture (18 files)
│   ├── README.md
│   ├── architecture/
│   ├── container/
│   ├── sdk-integration/
│   ├── security/
│   ├── terminal/
│   └── worktree/
│
├── diagrams/                          # Mermaid architecture diagrams (9)
│   ├── README.md
│   ├── 01-system-architecture.md
│   ├── 02-agent-execution-flow.md
│   ├── 03-state-machines.md
│   ├── 04-database-schema.md
│   ├── 05-api-route-map.md
│   ├── 06-event-streaming.md
│   ├── 07-sandbox-architecture.md
│   ├── 08-authentication-flow.md
│   └── 09-deployment-architecture.md
│
├── reviews/                           # Architecture reviews
│   └── 2026-02-architecture/          # Feb 2026 review (148 findings)
│
├── ideas/                             # Product roadmap (prioritized initiatives)
│   └── README.md                      # 29 initiatives across 4 priority tiers
│
├── roadmap/                           # Future plans (NOT for implementation)
│   ├── agent-runtime-architecture.md
│   ├── dual-database.md
│   ├── interactive-sessions.md
│   ├── phase2-sandbox-plugins.md
│   └── phase3-scim-provisioning.md
│
└── archive/                           # Historical/superseded specs
    ├── README.md
    ├── implementation-phases/
    ├── k8s-phase1/
    ├── ideas/
    ├── rbac-auth-original/
    ├── cli-monitor-original/
    ├── event-plugin-original/
    ├── task-scheduling-original/
    ├── tf-no-code-original/
    └── caddy-original/
```

---

## Quick Reference

| Task | Start With |
|------|------------|
| New feature | `application/user-stories.md` → `wireframes/` → component spec |
| API work | `application/api/endpoints.md` → service spec |
| UI component | `application/components/*.md` → `implementation/component-patterns.md` |
| State logic | `application/state-machines/*.md` → service spec |
| Database | `application/database/schema.md` |
| Architecture overview | `diagrams/01-system-architecture.md` |
| Agent execution | `diagrams/02-agent-execution-flow.md` → `services/agent-service.md` |
| Security/auth | `application/security/` |
| Testing | `application/testing/test-infrastructure.md` |
| Deployment | `application/operations/deployment.md` |
| Debugging | `application/errors/error-catalog.md` |

---

## Conventions

- **Source of truth**: `application/` specs are authoritative for all feature areas
- **Diagrams**: Reflect actual implementation; discrepancies with specs are noted
- **Roadmap**: Documents in `roadmap/` are explicitly NOT for implementation
- **Archive**: Historical specs preserved for reference only
- **Sandbox detail**: `sandbox/` contains deep architecture docs too large to inline into `application/`
