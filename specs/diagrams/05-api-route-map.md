# API Route Map

All 33 Hono route modules registered under `/api`, grouped by domain. Each module lives in `src/server/routes/<name>.ts` and is mounted by the main API router.

```mermaid
mindmap
  root((API Routes))
    Core
      projects
      tasks
      agents
      sessions
      worktrees
    Auth
      auth
        GET /github
        GET /github/callback
        POST /logout
      teams
      team-members
      team-projects
      team-invitations
      team-github-token
      me
      rbac-tokens
      invitation-accept
      project-members
    Features
      events
        sources CRUD
        subscriptions CRUD
        event log
        SSE stream
      terraform
        registries CRUD
        modules search
        validate
        compose
      cli-monitor
      sandbox
      sandbox-status
      settings
      api-keys
      templates
      marketplaces
      workflows
      workflow-designer
      tags
      task-creation
    Git
      git
        status
        branches
        commits
        remote-branches
      filesystem
    System
      health
        liveness
        readiness
      webhooks
      github
```
