# API Route Map

All Hono route modules registered under `/api`, grouped by domain. Each module lives in `src/server/routes/<name>.ts` and is mounted by the main API router. Core routes manage codespaces (formerly projects) and their child resources.

```mermaid
mindmap
  root((API Routes))
    Core
      codespaces
        skills
        tags
        members
      project-folders
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
      team-project-folders
      team-invitations
      team-github-token
      me
      rbac-tokens
      invitation-accept
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
      memory
        health
        conclusions CRUD
        sessions
        search
      cli-monitor
      sandbox
      sandbox-status
      sandbox-configs
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
