# AgentPane Database Schema

Entity-relationship diagrams for the AgentPane SQLite database. The schema is defined with Drizzle ORM across 36+ tables in `src/db/schema/sqlite/`. These diagrams show key columns (primary keys, foreign keys, status/type fields) and all foreign key relationships.

## 1. Core Domain

The central tables that drive agent-based task execution: projects own tasks, agents work on tasks within sessions, worktrees provide git isolation, and agent runs track execution history.

```mermaid
erDiagram
    projects {
        text id PK
        text name
        text path UK
        text github_installation_id FK
        text sandbox_config_id FK
        json config
        int max_concurrent_agents
    }

    tasks {
        text id PK
        text project_id FK
        text agent_id FK
        text session_id FK
        text worktree_id FK
        text title
        text column "backlog|queued|in_progress|waiting_approval|verified"
        text priority "high|medium|low"
        text last_agent_status "completed|cancelled|error|turn_limit|planning"
        json plan_options
        text plan
    }

    agents {
        text id PK
        text project_id FK
        text name
        text type "task|conversational|background"
        text status "idle|starting|planning|running|paused|error|completed"
        text current_task_id
        text current_session_id
        text parent_agent_id
        int current_turn
    }

    sessions {
        text id PK
        text project_id FK
        text task_id FK
        text agent_id FK
        text status "idle|initializing|active|paused|closing|closed|error"
        text url
        text sandbox_provider
        text sandbox_container_id
    }

    worktrees {
        text id PK
        text project_id FK
        text agent_id FK
        text task_id FK
        text branch
        text path
        text base_branch
        text status "creating|active|merging|removing|removed|error"
    }

    agent_runs {
        text id PK
        text agent_id FK
        text task_id FK
        text project_id FK
        text session_id FK
        text status
        int turns_used
        int tokens_used
        text error_message
    }

    audit_logs {
        text id PK
        text agent_id FK
        text agent_run_id FK
        text task_id FK
        text project_id FK
        text tool
        text status
        int duration_ms
    }

    projects ||--o{ tasks : "has"
    projects ||--o{ agents : "has"
    projects ||--o{ sessions : "has"
    projects ||--o{ worktrees : "has"
    projects ||--o{ agent_runs : "has"
    projects ||--o{ audit_logs : "has"

    agents ||--o{ tasks : "assigned to"
    agents ||--o{ sessions : "runs in"
    agents ||--o{ agent_runs : "has runs"
    agents ||--o{ audit_logs : "logged in"

    tasks ||--o{ agent_runs : "tracked by"
    tasks ||--o{ worktrees : "isolated in"
    tasks ||--o{ audit_logs : "logged for"
    tasks ||--o| sessions : "active in"

    sessions ||--o| agent_runs : "recorded in"

    agent_runs ||--o{ audit_logs : "logged in"
```

## 2. Auth and RBAC

Authentication via GitHub OAuth, session tokens, team-based access control with role inheritance, API tokens with scoped permissions, and tag-based organization for projects and tasks.

```mermaid
erDiagram
    users {
        text id PK
        int github_id UK
        text github_login
        text name
        text email
        text github_email
        text avatar_url
    }

    user_sessions {
        text id PK
        text user_id FK
        text token UK
        text expires_at
    }

    teams {
        text id PK
        text name
        text slug UK
        text description
    }

    team_members {
        text team_id PK_FK
        text user_id PK_FK
        text role "owner|admin|member|viewer"
    }

    team_invitations {
        text id PK
        text team_id FK
        text invited_by FK
        text email
        text role "owner|admin|member|viewer"
        text token UK
        text status "pending|accepted|expired"
    }

    team_projects {
        text team_id PK_FK
        text project_id PK_FK
    }

    project_members {
        text project_id PK_FK
        text user_id PK_FK
        text role "owner|admin|member|viewer"
        text granted_by_team_id FK
    }

    api_keys {
        text id PK
        text service UK
        text encrypted_key
        text masked_key
        int is_valid
    }

    api_tokens {
        text id PK
        text user_id FK
        text team_id FK
        text name
        text token_hash UK
        text token_prefix
        text role
        text scope_project_id FK
        text status "active|revoked|expired"
        int use_count
    }

    tags {
        text id PK
        text team_id FK
        text name
        text color
    }

    task_tags {
        text task_id PK_FK
        text tag_id PK_FK
    }

    project_tags {
        text project_id PK_FK
        text tag_id PK_FK
    }

    users ||--o{ user_sessions : "authenticates via"
    users ||--o{ team_members : "belongs to"
    users ||--o{ project_members : "member of"
    users ||--o{ api_tokens : "owns"
    users ||--o{ team_invitations : "sends"

    teams ||--o{ team_members : "has members"
    teams ||--o{ team_projects : "owns projects"
    teams ||--o{ team_invitations : "has invitations"
    teams ||--o{ api_tokens : "scopes tokens"
    teams ||--o{ tags : "defines"
    teams ||--o{ project_members : "grants via"

    tags ||--o{ task_tags : "applied to"
    tags ||--o{ project_tags : "applied to"
```

## 3. Extended Features

Supporting subsystems: event-driven automation (sources, subscriptions, log, schedules), sandbox infrastructure (configs, instances, tmux sessions), Terraform registry, templates and workflows, marketplace plugins, CLI monitoring, session telemetry, and GitHub integration.

```mermaid
erDiagram
    event_sources {
        text id PK
        text team_id FK
        text name
        text type "github|webhook|schedule|..."
        text slug UK
        text status "active|disabled|error"
        int is_enabled
        int event_count
    }

    event_subscriptions {
        text id PK
        text event_source_id FK
        text target_project_id FK
        text name
        int is_enabled
        json event_types
        json filters
        text prompt_template
        int auto_start_agent
        text task_column
        text task_priority
    }

    event_log {
        text id PK
        text event_source_id FK
        text event_type
        text action
        text status "received|matched|task_created|ignored|error"
        text delivery_id
        json matched_subscriptions
    }

    schedule_executions {
        text id PK
        text event_source_id FK
        text task_id FK
        text subscription_id FK
        text status
        text scheduled_at
        text executed_at
        text budget_window
    }

    sandbox_configs {
        text id PK
        text name
        text type "docker|kubernetes|nomad"
        int is_default
        text base_image
        int memory_mb
        real cpu_cores
        int timeout_minutes
    }

    sandbox_instances {
        text id PK
        text project_id FK_UK
        text container_id
        text status "running|stopped|error"
        text image
        int memory_mb
        int cpu_cores
    }

    sandbox_tmux_sessions {
        text id PK
        text sandbox_id FK
        text task_id FK
        text session_name
        int window_count
        int attached
    }

    terraform_registries {
        text id PK
        text name
        text org_name
        text status "active|syncing|error"
        int module_count
    }

    terraform_modules {
        text id PK
        text registry_id FK
        text name
        text namespace
        text provider
        text version
        text source
    }

    templates {
        text id PK
        text name
        text scope "org|project"
        text project_id FK
        text github_owner
        text github_repo
        text branch
        text status "active|syncing|error|disabled"
        json cached_skills
    }

    template_projects {
        text template_id PK_FK
        text project_id PK_FK
    }

    workflows {
        text id PK
        text name
        text source_template_id FK
        text status "draft|published|archived"
        json nodes
        json edges
        int ai_generated
    }

    plan_sessions {
        text id PK
        text task_id FK
        text project_id FK
        text status "active|waiting_user|completed|cancelled"
        json turns
    }

    marketplaces {
        text id PK
        text name
        text github_owner
        text github_repo
        text status "active|syncing|error"
        int is_default
        int is_enabled
        json cached_plugins
    }

    settings {
        text key PK
        text value
    }

    cli_sessions {
        text id PK
        text session_id UK
        text project_name
        text project_hash
        text status "idle|active|..."
        text model
        int message_count
        int turn_count
        text parent_session_id
        int is_subagent
    }

    session_events {
        text id PK
        text session_id FK
        int offset
        text type
        text channel
        json data
        int timestamp
    }

    session_summaries {
        text id PK
        text session_id FK_UK
        int duration_ms
        int turns_count
        int tokens_used
        int files_modified
        text final_status "success|failed|cancelled"
        real cost_usd
    }

    github_tokens {
        text id PK
        text team_id FK
        text encrypted_token
        text token_type "pat|oauth"
        text github_login
        int is_valid
    }

    github_installations {
        text id PK
        text installation_id UK
        text account_login
        text account_type
        text status
    }

    repository_configs {
        text id PK
        text installation_id FK
        text owner
        text repo
        json config
    }

    event_sources ||--o{ event_subscriptions : "triggers"
    event_sources ||--o{ event_log : "receives"
    event_sources ||--o{ schedule_executions : "schedules"

    event_subscriptions ||--o{ schedule_executions : "executes"

    sandbox_instances ||--o{ sandbox_tmux_sessions : "hosts"

    terraform_registries ||--o{ terraform_modules : "contains"

    templates ||--o{ template_projects : "assigned to"

    workflows ||--o| templates : "sourced from"

    github_installations ||--o{ repository_configs : "configures"

    session_events }o--|| sessions : "belongs to"
    session_summaries ||--|| sessions : "summarizes"
```
