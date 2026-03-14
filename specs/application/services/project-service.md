# ProjectService Specification

## Overview

The ProjectService manages CRUD operations for projects, configuration management, and GitHub synchronization. It provides a type-safe interface for managing project entities within AgentPane.

**Key Concept: Project = Working Context for a Repository**

- A project is a user's working context for a git repository
- Every project **must** be linked to a git repository (required, not optional)
- Project name is derived from the repository directory name
- Multiple users can have projects referencing the same repository
- The project holds user-specific: agent config, worktrees, session history, preferences

**Related Wireframes:**

- [Add Repository Dialog](../wireframes/new-project-dialog.html) - Repository selection
- [Project Settings](../wireframes/project-settings.html) - Working context configuration

---

## Constructor

```typescript
constructor(
  db: Database,
  worktreeService: {
    prune: (projectId: string) => Promise<Result<PruneResult, ProjectError>>;
  },
  runner: CommandRunner
)
```

The `CommandRunner` abstraction allows git operations to run either on the host or inside sandbox containers:

```typescript
type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
};
```

---

## Type Definitions

```typescript
type CreateProjectInput = {
  path: string;
  name?: string;
  description?: string;
  config?: Partial<ProjectConfig>;
  maxConcurrentAgents?: number;   // default: 3
  sandboxConfigId?: string;        // FK to sandbox_configs table
};

type UpdateProjectInput = {
  maxConcurrentAgents?: number;
  configPath?: string;
  githubOwner?: string;
  githubRepo?: string;
};

type ListProjectsOptions = {
  limit?: number;           // default: 50
  offset?: number;          // default: 0
  orderBy?: 'name' | 'createdAt' | 'updatedAt';   // default: 'updatedAt'
  orderDirection?: 'asc' | 'desc';                  // default: 'desc'
};

type PathValidation = {
  name: string;
  path: string;
  hasClaudeConfig: boolean;
  hasClaudeConfigError?: string;
  defaultBranch: string;
  remoteUrl?: string;
};

type ProjectSummary = {
  project: Project;
  taskCounts: {
    backlog: number;
    inProgress: number;
    waitingApproval: number;
    verified: number;
    total: number;
  };
  runningAgents: Array<{
    id: string;
    name: string;
    currentTaskId: string | null;
    currentTaskTitle?: string;
  }>;
  status: 'running' | 'idle' | 'needs-approval';
  lastActivityAt: string | null;
};
```

---

## Method Specifications

### create

Creates a new project as a working context for a git repository.

```typescript
async create(input: CreateProjectInput): Promise<Result<Project, ProjectError>>
```

**Business Rules:**
1. Path is normalized via `path.resolve()`
2. Validates path is a git repository via `validatePath()`
3. Checks for duplicate paths (returns `PATH_EXISTS`)
4. Name is derived from directory name
5. Config is merged with `DEFAULT_PROJECT_CONFIG` and validated
6. Supports optional `sandboxConfigId` FK linking to a sandbox configuration
7. Validates config does not contain secrets via `containsSecrets()`

### getById

```typescript
async getById(id: string): Promise<Result<Project, ProjectError>>
```

### list

```typescript
async list(options?: ListProjectsOptions): Promise<Result<Project[], ProjectError>>
```

### listWithSummaries

Returns projects enriched with task counts, running agents, and overall status.

```typescript
async listWithSummaries(options?: ListProjectsOptions): Promise<Result<ProjectSummary[], ProjectError>>
```

For each project:
- Counts tasks by column
- Lists running agents with their current task titles
- Determines status: `running` (has agents), `needs-approval` (has waiting tasks), or `idle`
- Includes last activity timestamp

### update

```typescript
async update(id: string, input: UpdateProjectInput): Promise<Result<Project, ProjectError>>
```

Supports updating `maxConcurrentAgents`, `configPath`, `githubOwner`, and `githubRepo`.

### delete

```typescript
async delete(id: string): Promise<Result<void, ProjectError>>
```

**Business Rules:**
1. Cannot delete if running agents exist
2. Prunes worktrees before deletion
3. Cascade handles related records (tasks, agents, sessions, etc.)

### updateConfig

```typescript
async updateConfig(id: string, config: Partial<ProjectConfig>): Promise<Result<Project, ProjectError>>
```

Validates config via Zod schema before saving.

### syncFromGitHub

Syncs project configuration from GitHub repository.

```typescript
async syncFromGitHub(id: string): Promise<Result<Project, ProjectError>>
```

**Flow:**
1. Validate project has `githubOwner`, `githubRepo`, and `githubInstallationId`
2. Get installation-scoped Octokit client
3. Fetch config from the repository's `configPath` (default: `.claude`)
4. Validate and merge with existing config
5. Update project

### cloneRepository

Clones a repository from URL to a local path.

```typescript
async cloneRepository(
  url: string,
  destinationDir: string
): Promise<Result<{ path: string; name: string }, ProjectError>>
```

Handles browser environment gracefully (returns path info without cloning).

### validatePath

Validates a filesystem path for project creation using the `CommandRunner`.

```typescript
async validatePath(projectPath: string): Promise<Result<PathValidation, ProjectError>>
```

Uses git commands (`git rev-parse`, `git remote get-url`, `git symbolic-ref`) via the command runner rather than direct filesystem access.

### validateConfig

```typescript
validateConfig(config: Partial<ProjectConfig>): Result<ProjectConfig, ProjectError>
```

Uses `projectConfigSchema` from `src/lib/config/schemas.ts`. Also checks for secrets via `containsSecrets()`.

---

## Error Conditions

| Error Code | HTTP | Condition |
|------------|------|-----------|
| `PROJECT_NOT_FOUND` | 404 | Project ID doesn't exist |
| `PROJECT_PATH_INVALID` | 400 | Path doesn't exist or not accessible |
| `PROJECT_NOT_A_GIT_REPO` | 400 | Path is not a git repository |
| `PROJECT_PATH_EXISTS` | 409 | Project with this path already exists |
| `PROJECT_CONFIG_INVALID` | 400 | Config validation failed |
| `PROJECT_HAS_RUNNING_AGENTS` | 409 | Cannot delete with running agents |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/project.service.ts` | Project service implementation |
| `src/lib/config/schemas.ts` | `projectConfigSchema` Zod validation |
| `src/lib/config/types.ts` | `DEFAULT_PROJECT_CONFIG` |
| `src/lib/config/validate-secrets.ts` | `containsSecrets()` |
| `src/lib/github/client.ts` | `getInstallationOctokit()` |
| `src/lib/github/config-sync.ts` | `syncConfigFromGitHub()` |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | Project table definition |
| [Error Catalog](../errors/error-catalog.md) | ProjectError types |
| [TaskService](./task-service.md) | Tasks belong to projects |
| [API Endpoints](../api/endpoints.md) | HTTP routes for project operations |
| [GitHub App](../integrations/github-app.md) | GitHub sync integration |
