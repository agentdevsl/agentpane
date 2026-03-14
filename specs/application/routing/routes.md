# TanStack Start Routing Specification

## Overview

Complete routing configuration for AgentPane using TanStack Start file-based routing. Defines client-side routes with layout nesting and navigation patterns for the multi-agent task management system.

Server API routes are handled by Hono and documented separately in [API Endpoints](../api/endpoints.md).

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| TanStack Start | 1.150.0 | Full-stack React framework with file-based routing |
| TanStack Router | 1.150.0 | Type-safe client routing with loaders |
| Bun | 1.3.10 | Server runtime |

---

## Root Layout (`__root.tsx`)

The root layout wraps every route in the application and provides:

- **ShortcutsProvider** -- Global keyboard shortcut handling
- **ProjectContextProvider** -- Active project context shared across routes
- **TooltipProvider** -- Radix tooltip delay configuration
- **Toaster** -- Toast notification container
- **GlobalShortcutsWithPicker** -- Command palette (`Cmd+K`) integration
- **RootErrorComponent** -- Catch-all error boundary with "Try again" / "Go home" actions
- **NotFoundComponent** -- 404 page with "Go home" action

```
ShortcutsProvider
  ProjectContextProvider
    TooltipProvider (delayDuration=300)
      <div min-h-screen bg-canvas>
        <Outlet />          ← child route renders here
        <Toaster />
        <GlobalShortcutsWithPicker />
      </div>
```

---

## Route Map

### Dashboard

| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Dashboard` | Home page with project cards grid, search, new project wizard. Shows first-run welcome state when no projects exist. Polls for running-agent updates. |

### Projects

| Path | Component | Description |
|------|-----------|-------------|
| `/projects` | `ProjectsPage` | All projects list with search, sort (recent/name/created), and new project wizard |
| `/projects/$projectId` | `ProjectKanban` | Kanban board for a single project. Drag-drop task columns, AI task creation, sandbox status indicator |
| `/projects/$projectId/settings` | `ProjectSettingsPage` | Project configuration: name, description, max concurrent agents, project config |
| `/projects/$projectId/git` | `ProjectGitPage` | Git repository view (branches, commits, diffs) for a project |
| `/projects/$projectId/worktrees` | `ProjectWorktreesPage` | Git worktree management for a project |
| `/projects/$projectId/tasks/$taskId` | `TaskDetailRoute` | Task detail dialog opened as a full route (deep-linkable) |

### Agents

| Path | Component | Description |
|------|-----------|-------------|
| `/agents` | `AgentsPage` | All agents across projects with status and type display |
| `/agents/$agentId` | `AgentDetailPage` | Single agent detail with status, current task, and configuration dialog |

### Sessions

| Path | Component | Description |
|------|-----------|-------------|
| `/sessions` | `SessionsPage` | Session history list with project filter. Uses `SessionHistory` component |
| `/sessions/$sessionId` | `SessionPage` | Real-time session view. Renders `ContainerAgentPanel` for Docker/K8s sessions or `AgentSessionView` for SDK sessions. Supports plan approve/reject |

### CLI Monitor

| Path | Component | Layout | Description |
|------|-----------|--------|-------------|
| `/cli-monitor` | `CliMonitorLayout` | Layout | Layout wrapper with `CliMonitorProvider`, view switcher (Cards/Terminal/Timeline), daemon toggle, and status indicator |
| `/cli-monitor/` | `CliMonitorCardsView` | Child | Default cards view: install state, waiting state, or active session cards grouped by project with detail panel |
| `/cli-monitor/terminal` | `TerminalView` | Child | 2x2 terminal grid with session picker for assigning sessions to panes |
| `/cli-monitor/timeline` | `TimelineView` | Child | Swimlane timeline with time range selector (1h/3h/12h/24h) and session detail panel |

### Workflow Catalog & Designer

| Path | Component | Description |
|------|-----------|-------------|
| `/catalog` | `CatalogPage` | Split-view workflow catalog: searchable list (left) + detail panel with preview, stats, node breakdown (right) |
| `/catalog/$workflowId` | `WorkflowDetailPage` | Read-only workflow detail with full `WorkflowDesigner` view. Edit/delete actions |
| `/designer` | `DesignerPage` | Visual workflow designer (React Flow). Supports `?id=<workflowId>` query param to load existing workflow |

### Terraform Compose

| Path | Component | Layout | Description |
|------|-----------|--------|-------------|
| `/terraform` | `TerraformLayout` | Layout | Layout wrapper with `TerraformProvider`, view switcher, sync bar, and download action |
| `/terraform/` | `TerraformComposeView` | Child | AI chat panel (left) + code/dependencies/variables panel (right) with resizable splitter |
| `/terraform/history` | `TerraformHistoryView` | Child | Composition history list |
| `/terraform/modules` | `TerraformModulesView` | Child | Module catalog browser |
| `/terraform/modules/$moduleId` | `TerraformModuleDetailView` | Child | Single module detail page |
| `/terraform/settings` | `TerraformSettingsView` | Child | Terraform-specific settings (registries, defaults) |

### Events

| Path | Component | Layout | Description |
|------|-----------|--------|-------------|
| `/events` | `EventsLayout` | Layout | Layout wrapper with breadcrumbs for event sub-routes |
| `/events/` | `EventsIndex` | Child | Redirects to `/events/sources` |
| `/events/sources` | `EventSourcesPage` | Child | Event source configuration (GitHub, Linear, etc.) |
| `/events/log` | `EventLogPage` | Child | Event log timeline |
| `/events/subscriptions` | `SubscriptionsPage` | Child | Subscription rules for auto-creating tasks from events |

### Settings

| Path | Component | Layout | Description |
|------|-----------|--------|-------------|
| `/settings` | `SettingsLayout` | Layout | Settings layout with `SettingsSidebar` navigation |
| `/settings/` | _(redirect)_ | - | Redirects to `/settings/api-keys` |
| `/settings/api-keys` | `ApiKeysSettings` | Child | Anthropic API key and other credential management |
| `/settings/github` | `GitHubSettings` | Child | GitHub token, OAuth, and repository integration |
| `/settings/appearance` | `AppearanceSettings` | Child | Theme toggle (light/dark/system) and color scheme |
| `/settings/preferences` | `PreferencesSettings` | Child | Agent defaults, notifications, behavior settings |
| `/settings/sandbox` | `SandboxSettings` | Child | Sandbox mode (Docker/DevContainer/K8s), container configuration |
| `/settings/prompts` | `PromptsSettings` | Child | System prompt customization and prompt registry |
| `/settings/model-optimizations` | `ModelOptimizationsSettings` | Child | Model selection, context optimization, performance tuning |
| `/settings/cli-monitor` | `CliMonitorSettings` | Child | CLI monitor daemon configuration and data retention |
| `/settings/system` | `SystemSettings` | Child | System info, database, health checks, version |
| `/settings/agents` | _(redirect)_ | - | Redirects to `/agents` |
| `/settings/projects` | _(redirect)_ | - | Redirects to `/projects` |
| `/settings/terraform` | _(redirect)_ | - | Redirects to `/terraform/settings` |

### Templates

| Path | Component | Description |
|------|-----------|-------------|
| `/templates/org` | `OrgTemplatesPage` | Organization-level CLAUDE.md templates management |
| `/templates/project` | `ProjectTemplatesPage` | Project-level CLAUDE.md templates management with project association |

### Other

| Path | Component | Description |
|------|-----------|-------------|
| `/marketplace` | `MarketplacePage` | Plugin marketplace browser. Syncs with GitHub-hosted plugin repositories. Add/remove/sync marketplace sources |
| `/queue` | `QueuePage` | Agent execution queue with position display and estimated wait times |
| `/worktrees` | `WorktreesPage` | Global worktree management across all projects |

---

## Layout Nesting

The application uses three layout patterns:

### 1. No Additional Layout (default)

Most routes render directly inside the root layout's `<Outlet />` and use the `LayoutShell` component individually for consistent breadcrumbs and header actions.

Routes: `/`, `/projects`, `/projects/$projectId`, `/agents`, `/sessions`, `/catalog`, `/designer`, `/marketplace`, `/queue`, `/worktrees`, `/templates/*`

### 2. Sidebar Layout

Routes that use a persistent sidebar for sub-navigation.

**Settings** (`/settings`):
```
SettingsLayout
  ├── SettingsSidebar (left)
  └── <Outlet /> (right, scrollable)
```

### 3. Provider + Outlet Layout

Routes that wrap children in a shared context provider and provide tabbed or view-switched navigation.

**CLI Monitor** (`/cli-monitor`):
```
CliMonitorLayout
  └── CliMonitorProvider
        ├── LayoutShell (breadcrumbs, view switcher, status indicators)
        ├── Offline/connection error banners
        └── <Outlet /> (cards | terminal | timeline view)
```

**Terraform** (`/terraform`):
```
TerraformLayout
  └── TerraformProvider
        ├── LayoutShell (breadcrumbs, view switcher, sync bar, download)
        └── <Outlet /> (compose | history | modules | settings view)
```

**Events** (`/events`):
```
EventsLayout
  └── LayoutShell (breadcrumbs)
        └── <Outlet /> (sources | log | subscriptions)
```

---

## File Structure

```
src/app/routes/
├── __root.tsx                          # Root layout (providers, error/404)
├── index.tsx                           # / - Dashboard
│
├── projects/
│   ├── index.tsx                       # /projects - Project list
│   └── $projectId/
│       ├── index.tsx                   # /projects/$projectId - Kanban board
│       ├── settings.tsx               # /projects/$projectId/settings
│       ├── git.tsx                     # /projects/$projectId/git
│       ├── worktrees.tsx              # /projects/$projectId/worktrees
│       └── tasks/
│           └── $taskId.tsx            # /projects/$projectId/tasks/$taskId
│
├── agents/
│   ├── index.tsx                       # /agents - Agent list
│   └── $agentId.tsx                   # /agents/$agentId - Agent detail
│
├── sessions/
│   ├── index.tsx                       # /sessions - Session history
│   └── $sessionId.tsx                 # /sessions/$sessionId - Live session
│
├── cli-monitor.tsx                     # /cli-monitor - Layout (CliMonitorProvider)
├── cli-monitor/
│   ├── index.tsx                       # /cli-monitor/ - Cards view
│   ├── terminal.tsx                   # /cli-monitor/terminal - Terminal grid
│   └── timeline.tsx                   # /cli-monitor/timeline - Swimlane view
│
├── catalog/
│   ├── index.tsx                       # /catalog - Workflow catalog
│   └── $workflowId.tsx               # /catalog/$workflowId - Workflow detail
│
├── designer/
│   └── index.tsx                       # /designer - Visual workflow editor
│
├── terraform.tsx                       # /terraform - Layout (TerraformProvider)
├── terraform/
│   ├── index.tsx                       # /terraform/ - Compose view
│   ├── history.tsx                    # /terraform/history
│   ├── modules.tsx                    # /terraform/modules - Module catalog
│   ├── modules.$moduleId.tsx          # /terraform/modules/$moduleId
│   └── settings.tsx                   # /terraform/settings
│
├── events.tsx                          # /events - Layout
├── events/
│   ├── index.tsx                       # /events/ - Redirects to /events/sources
│   ├── sources.tsx                    # /events/sources
│   ├── log.tsx                        # /events/log
│   └── subscriptions.tsx             # /events/subscriptions
│
├── settings.tsx                        # /settings - Layout (SettingsSidebar)
├── settings/
│   ├── index.tsx                       # /settings/ - Redirects to /settings/api-keys
│   ├── api-keys.tsx                   # /settings/api-keys
│   ├── github.tsx                     # /settings/github
│   ├── appearance.tsx                 # /settings/appearance
│   ├── preferences.tsx               # /settings/preferences
│   ├── sandbox.tsx                    # /settings/sandbox
│   ├── prompts.tsx                    # /settings/prompts
│   ├── model-optimizations.tsx        # /settings/model-optimizations
│   ├── cli-monitor.tsx               # /settings/cli-monitor
│   ├── system.tsx                     # /settings/system
│   ├── agents.tsx                     # /settings/agents - Redirects to /agents
│   ├── projects.tsx                   # /settings/projects - Redirects to /projects
│   └── terraform.tsx                  # /settings/terraform - Redirects to /terraform/settings
│
├── templates/
│   ├── org.tsx                        # /templates/org
│   └── project.tsx                    # /templates/project
│
├── marketplace/
│   └── index.tsx                       # /marketplace
│
├── queue/
│   └── index.tsx                       # /queue
│
└── worktrees/
    └── index.tsx                       # /worktrees
```

---

## Navigation Patterns

### Redirects

Several routes exist solely to redirect users to the canonical location:

| From | To | Reason |
|------|----|--------|
| `/settings/` | `/settings/api-keys` | API keys are the most critical first-time setup |
| `/settings/agents` | `/agents` | Agent management lives at top-level |
| `/settings/projects` | `/projects` | Project management lives at top-level |
| `/settings/terraform` | `/terraform/settings` | Terraform settings live under the terraform section |
| `/events/` | `/events/sources` | Sources is the default events sub-view |

### Deep Links

All routes are deep-linkable. Key shareable URLs:

- `/sessions/$sessionId` -- Share a live or historical session
- `/projects/$projectId/tasks/$taskId` -- Link directly to a task
- `/catalog/$workflowId` -- Link to a workflow
- `/terraform/modules/$moduleId` -- Link to a Terraform module
- `/agents/$agentId` -- Link to an agent's detail page

### LayoutShell

Most pages use the `LayoutShell` component which provides:
- Breadcrumb navigation with optional links
- Header action buttons (right-aligned)
- Center actions (e.g., AI action button, view switcher)
- Optional `projectId`, `projectName`, `projectPath` context for project-scoped pages

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](../api/endpoints.md) | Server route implementations (Hono) |
| [Project Service](../services/project-service.md) | Project route data fetching |
| [Task Service](../services/task-service.md) | Task CRUD and Kanban operations |
| [Agent Service](../services/agent-service.md) | Agent lifecycle and status |
| [Session Service](../services/session-service.md) | Session SSE streaming |
| [Database Schema](../database/schema.md) | Data types used in routes |
| [Error Catalog](../errors/error-catalog.md) | Route error handling |
| [User Stories](../user-stories.md) | Navigation requirements |
| [Component Patterns](../implementation/component-patterns.md) | UI component implementation |
