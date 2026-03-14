# Archived Specifications

This directory contains historical and superseded specifications. These documents are preserved for reference but are **no longer the source of truth** for any feature area.

## Contents

| Directory | Original Location | Reason Archived |
|-----------|-------------------|----------------|
| `implementation-phases/` | `specs/implementation/` | References PGlite, outdated SDK versions; superseded by actual implementation |
| `k8s-phase1/` | `specs/K8s/` | Phase 1 archived in code; Phase 2 CRD approach replaced it |
| `ideas/` | `specs/ideas/` | Experimental JSX prototype, not pursued |
| `rbac-auth-original/` | `specs/rbac-auth/` | Consolidated into `application/security/rbac.md` |
| `cli-monitor-original/` | `specs/CLI_monitor/` | Consolidated into `application/services/cli-monitor-service.md` |
| `event-plugin-original/` | `specs/event-plugin-system/` | Consolidated into `application/services/event-service.md` |
| `task-scheduling-original/` | `specs/task-scheduling-system/` | Consolidated into `application/services/scheduler-service.md` |
| `tf-no-code-original/` | `specs/tf-no-code/` | Consolidated into `application/integrations/terraform-registry.md` |
| `caddy-original/` | `specs/caddy/` | Consolidated into `application/integrations/caddy.md` |

## Policy

- Do not update archived specs — update the consolidated version in `application/` instead
- Archived specs may be deleted once the consolidated versions are verified complete
