# Configuration Management Specification

## Overview

The Configuration Management system handles all configuration loading, validation, and hot-reload capabilities for AgentPane. It provides a unified interface for accessing environment variables, project settings, agent skills, and application defaults with proper precedence rules and type-safe validation using Zod schemas.

**Configuration Model:** Hybrid global + per-project, following Claude Code conventions. This provides:

- **Global (User-level)**: Personal skills, preferences, and defaults at `~/.claude/`
- **Per-Project**: Project-specific config synced from Git repository `.claude/` folder
- **Merge Strategy**: Project config overrides global; environment variables override all

**Related Specifications:**

- [Project Service](../services/project-service.md) - Uses config for project-level settings
- [GitHub App](../integrations/github-app.md) - Repository config sync via webhooks
- [Database Schema](../database/schema.md) - `projects.config` JSONB field

---

## Configuration Hierarchy

AgentPane loads configuration from multiple sources and merges them with clear precedence:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Environment Variables (HIGHEST PRIORITY)                             │
│    - ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.                              │
│    - Always override everything                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Per-Project Configuration                                            │
│    - Location: {project}/.claude/                                       │
│    - Source: Local filesystem OR synced from GitHub                     │
│    - Contains: Project-specific skills, commands, agents, settings      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Global User Configuration                                            │
│    - Location: ~/.claude/                                               │
│    - Contains: Personal skills, preferences, default settings           │
│    - Shared across all projects                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Application Defaults (LOWEST PRIORITY)                               │
│    - Hard-coded fallbacks                                               │
│    - Ensures all fields have values                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Merge Behavior

| Resource Type | Merge Strategy |
|---------------|----------------|
| `settings.json` | Deep merge, project overrides global |
| `skills/` | Union of both, project version wins on conflict |
| `commands/` | Union of both, project version wins on conflict |
| `agents/` | Union of both, project version wins on conflict |
| `CLAUDE.md` | Concatenated (global first, then project) |

---

## Directory Structure

### Global Configuration (`~/.claude/`)

User-level configuration shared across all projects:

```
~/.claude/
├── settings.json             # Global user preferences
├── CLAUDE.md                 # Personal instructions (always included)
├── commands/                 # Personal slash commands
│   └── my-workflow.md        # Available in all projects
├── skills/                   # Personal skills
│   └── my-style/
│       └── SKILL.md          # Personal coding style skill
└── agents/                   # Personal subagents
    └── assistant.md          # Personal helper agent
```

### Per-Project Configuration (`{project}/.claude/`)

Project-specific configuration, typically synced from GitHub:

```
your-project/
├── .claude/
│   ├── settings.json         # Project settings (overrides global)
│   ├── CLAUDE.md             # Project instructions (appended to global)
│   ├── commands/             # Project slash commands
│   │   ├── review.md         # /review - Code review command
│   │   ├── test.md           # /test - Test generation command
│   │   └── deploy.md         # /deploy - Deployment command
│   ├── skills/               # Project skills (auto-activated)
│   │   ├── code-review/
│   │   │   └── SKILL.md      # Skill definition with YAML frontmatter
│   │   ├── testing/
│   │   │   └── SKILL.md
│   │   └── security/
│   │       └── SKILL.md
│   └── agents/               # Project subagents
│       ├── reviewer.md       # Code review subagent
│       ├── tester.md         # Test writing subagent
│       └── planner.md        # Planning subagent
├── src/
├── AGENTS.md                 # Auto-included in agent context (legacy)
└── CLAUDE.md                 # Alternative location (project root)
```

### Application Data (`~/.agentpane/` or `DATA_DIR`)

AgentPane-specific application data (not Claude Code compatible):

```
~/.agentpane/
├── settings.json             # App preferences (theme, shortcuts)
├── credentials.json          # Encrypted API keys (if not using env vars)
├── sessions/                 # Session history and metadata
│   └── {session-id}.json
└── cache/                    # Temporary cache data
```

### Directory Purposes

| Directory | Scope | Purpose | Invocation |
|-----------|-------|---------|------------|
| `commands/` | Global + Project | User-invoked slash commands | `/command-name` in chat |
| `skills/` | Global + Project | Auto-activated context providers | Automatic based on task context |
| `agents/` | Global + Project | Specialized subagents | `@agent-name` or via Task tool |

### Sync Triggers

Configuration and skills are automatically synced when:

1. **Webhook Push**: GitHub App receives `push` event to default branch
2. **Manual Sync**: User clicks "Sync from GitHub" in project settings
3. **Project Link**: Project is first linked to a GitHub repository
4. **Periodic Refresh**: Background sync every 15 minutes (configurable)

### Sync Behavior

```typescript
// lib/github/config-sync.ts
export interface SyncResult {
  config: ProjectConfig | null;    // null if no settings.json found
  skills: SkillConfig[];           // Empty array if no skills/ folder
  prompts: PromptFragment[];       // Optional reusable prompts
  sha: string;                     // Git commit SHA for cache invalidation
  syncedAt: Date;
}

// Only syncs if SHA changed (efficient caching)
export async function syncFromRepository(
  installationId: number,
  owner: string,
  repo: string,
  branch: string = 'main',
  currentSha?: string
): Promise<Result<SyncResult | null, SyncError>>
```

---

## Interface Definition

```typescript
// lib/config/config-service.ts
import type { Result } from '@/lib/utils/result';
import type { ConfigError } from '@/lib/errors/config-errors';

export interface IConfigService {
  // ─────────────────────────────────────────────────────────────────
  // Environment Variables
  // ─────────────────────────────────────────────────────────────────
  getEnv<K extends keyof EnvConfig>(key: K): EnvConfig[K];
  validateEnv(): Result<EnvConfig, ConfigError>;

  // ─────────────────────────────────────────────────────────────────
  // Global Configuration (~/.claude/)
  // ─────────────────────────────────────────────────────────────────
  loadGlobalConfig(): Promise<Result<GlobalConfig, ConfigError>>;
  getGlobalConfigPath(): string;  // Returns ~/.claude/
  discoverGlobalSkills(): Promise<Result<SkillConfig[], ConfigError>>;
  discoverGlobalCommands(): Promise<Result<CommandConfig[], ConfigError>>;
  discoverGlobalAgents(): Promise<Result<SubagentConfig[], ConfigError>>;

  // ─────────────────────────────────────────────────────────────────
  // Project Configuration ({project}/.claude/)
  // ─────────────────────────────────────────────────────────────────
  loadProjectConfig(projectPath: string): Promise<Result<ProjectConfig, ConfigError>>;
  validateProjectConfig(config: unknown): Result<ProjectConfig, ConfigError>;
  watchProjectConfig(projectPath: string, onChange: (config: ProjectConfig) => void): () => void;
  discoverProjectSkills(projectPath: string): Promise<Result<SkillConfig[], ConfigError>>;
  discoverProjectCommands(projectPath: string): Promise<Result<CommandConfig[], ConfigError>>;
  discoverProjectAgents(projectPath: string): Promise<Result<SubagentConfig[], ConfigError>>;

  // ─────────────────────────────────────────────────────────────────
  // GitHub Sync (for project config)
  // ─────────────────────────────────────────────────────────────────
  syncFromRepo(projectId: string): Promise<Result<SyncResult, ConfigError>>;

  // ─────────────────────────────────────────────────────────────────
  // Merged Configuration (global + project + env)
  // ─────────────────────────────────────────────────────────────────
  getMergedConfig(projectId: string): Promise<Result<MergedConfig, ConfigError>>;
  getMergedSkills(projectId: string): Promise<Result<SkillConfig[], ConfigError>>;
  getMergedCommands(projectId: string): Promise<Result<CommandConfig[], ConfigError>>;
  getMergedAgents(projectId: string): Promise<Result<SubagentConfig[], ConfigError>>;
  resolveSlashCommand(projectId: string, input: string): Promise<Result<ResolvedCommand, ConfigError>>;

  // ─────────────────────────────────────────────────────────────────
  // Application Configuration
  // ─────────────────────────────────────────────────────────────────
  getAppConfig(): AppConfig;
  getAppDataPath(): string;  // Returns ~/.agentpane/
  getDefaults(): ConfigDefaults;
}

export interface GlobalConfig {
  /** Global user settings from ~/.claude/settings.json */
  settings: Partial<ProjectConfig>;

  /** Global CLAUDE.md content */
  instructions?: string;

  /** Path to global config directory */
  configPath: string;
}

export interface ResolvedCommand {
  /** The matched slash command */
  command: SlashCommand;

  /** The skill to invoke */
  skill: SkillConfig;

  /** Parsed arguments from user input */
  args: Record<string, string>;

  /** Original user input */
  rawInput: string;
}
```

---

## Type Definitions

### Environment Configuration

```typescript
// lib/config/types.ts
export interface EnvConfig {
  // Required
  ANTHROPIC_API_KEY: string;

  // Optional with defaults
  GITHUB_TOKEN?: string;
  DATABASE_URL?: string;
  APP_URL?: string;

  // GitHub App (optional)
  GITHUB_APP_ID?: string;
  GITHUB_APP_NAME?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;

  // Development
  NODE_ENV: 'development' | 'production' | 'test';
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
}
```

### Project Configuration

```typescript
// lib/config/types.ts
export interface ProjectConfig {
  /** Directory for git worktrees relative to project root */
  worktreeRoot: string;

  /** Script to run after worktree creation (e.g., "bun install") */
  initScript?: string;

  /** Path to .env file to copy into worktrees */
  envFile?: string;

  /** Default branch for the repository */
  defaultBranch: string;

  /** Maximum concurrent agents for this project (3-6 recommended) */
  maxConcurrentAgents: number;

  /** Whitelist of tools agents can use */
  allowedTools: string[];

  /** Maximum turns per agent execution */
  maxTurns: number;

  /** Claude model to use */
  model?: string;

  /** Custom system prompt for agents */
  systemPrompt?: string;

  /** Temperature for model responses (0-1) */
  temperature?: number;

  /** Skills to load from repository (subfolder names or URLs) */
  skills?: string[];
}
```

### Skills Configuration

Skills are markdown files that provide specialized prompts and instructions for agents. They are stored in the `.claude/skills/` directory and synced from the repository.

```typescript
// lib/config/types.ts
export interface SkillConfig {
  /** Unique skill identifier (filename without extension) */
  id: string;

  /** Display name for the skill */
  name: string;

  /** Brief description of what this skill does */
  description: string;

  /** The skill prompt/instructions (markdown content) */
  content: string;

  /** When to auto-activate this skill (optional) */
  triggers?: SkillTrigger[];

  /** Source location */
  source: SkillSource;

  /** Last synced timestamp */
  syncedAt: Date;
}

export interface SkillTrigger {
  /** Trigger type: task label, file pattern, or manual */
  type: 'label' | 'file_pattern' | 'manual';

  /** The pattern to match (e.g., "code-review" label or "*.test.ts" pattern) */
  pattern: string;
}

export type SkillSource =
  | { type: 'repository'; owner: string; repo: string; path: string; sha: string }
  | { type: 'local'; path: string }
  | { type: 'builtin'; name: string };

export interface SkillManifest {
  /** Skills available for this project */
  skills: SkillConfig[];

  /** Default skills to apply to all agents */
  defaultSkills: string[];

  /** Skills that require explicit activation */
  optionalSkills: string[];

  /** Slash commands registered for this project */
  slashCommands: SlashCommand[];
}

export interface SlashCommand {
  /** Command name without the slash (e.g., "review" for /review) */
  command: string;

  /** Brief description shown in autocomplete */
  description: string;

  /** Skill ID to invoke when command is used */
  skillId: string;

  /** Optional arguments the command accepts */
  arguments?: SlashCommandArg[];

  /** Aliases for this command (e.g., ["r"] for /review) */
  aliases?: string[];
}

export interface SlashCommandArg {
  /** Argument name */
  name: string;

  /** Argument description */
  description: string;

  /** Is this argument required? */
  required: boolean;

  /** Argument type */
  type: 'string' | 'file' | 'branch' | 'task';

  /** Default value if not provided */
  default?: string;
}

// ─────────────────────────────────────────────────────────────────
// Subagent Configuration (following Claude Code patterns)
// ─────────────────────────────────────────────────────────────────

export interface SubagentConfig {
  /** Unique subagent identifier (filename without extension) */
  id: string;

  /** Display name for the subagent */
  name: string;

  /** When to use this subagent (shown in Task tool description) */
  description: string;

  /** Custom system prompt for this subagent */
  systemPrompt: string;

  /** Tools this subagent can access */
  allowedTools: string[];

  /** Model to use (defaults to project model) */
  model?: string;

  /** Maximum turns for this subagent */
  maxTurns?: number;

  /** Source location */
  source: SubagentSource;

  /** Last synced timestamp */
  syncedAt: Date;
}

export type SubagentSource =
  | { type: 'repository'; owner: string; repo: string; path: string; sha: string }
  | { type: 'local'; path: string }
  | { type: 'builtin'; name: string };

// ─────────────────────────────────────────────────────────────────
// Command Configuration (user-invoked slash commands)
// ─────────────────────────────────────────────────────────────────

export interface CommandConfig {
  /** Command name (e.g., "review" for /review) */
  command: string;

  /** Brief description shown in autocomplete */
  description: string;

  /** The command instructions (markdown content) */
  content: string;

  /** Optional arguments the command accepts */
  arguments?: SlashCommandArg[];

  /** Aliases for this command (e.g., ["r"] for /review) */
  aliases?: string[];

  /** Source location */
  source: CommandSource;

  /** Last synced timestamp */
  syncedAt: Date;
}

export type CommandSource =
  | { type: 'repository'; owner: string; repo: string; path: string; sha: string }
  | { type: 'local'; path: string }
  | { type: 'builtin'; name: string };

// ─────────────────────────────────────────────────────────────────
// Complete Project Manifest
// ─────────────────────────────────────────────────────────────────

export interface ProjectManifest {
  /** Skills available for this project (auto-activated) */
  skills: SkillConfig[];

  /** Subagents available for this project */
  subagents: SubagentConfig[];

  /** Slash commands registered for this project */
  commands: CommandConfig[];

  /** Built-in slash commands (always available) */
  builtinCommands: SlashCommand[];

  /** Default skills to apply to all agents */
  defaultSkills: string[];

  /** Last sync timestamp */
  syncedAt: Date;

  /** Git SHA of the synced configuration */
  sha?: string;
}
```

### Skill File Format (SKILL.md)

Skills are directories containing a `SKILL.md` file with YAML frontmatter. Skills are auto-activated based on context matching (task description, file patterns, etc.).

**Location:** `.claude/skills/{skill-name}/SKILL.md`

```markdown
---
name: Code Review
description: Thorough code review with security and performance focus
triggers:
  - type: description
    pattern: "review|code review|pr review"
  - type: file_pattern
    pattern: "*.{ts,tsx,js,jsx}"
---

# Code Review Skill

You are performing a code review. Focus on:

## Security
- Check for injection vulnerabilities
- Validate input sanitization
- Review authentication/authorization

## Performance
- Identify N+1 queries
- Check for unnecessary re-renders
- Review memory usage patterns

## Code Quality
- Enforce consistent naming conventions
- Check for proper error handling
- Verify test coverage

Provide specific, actionable feedback with line references.
```

### Command File Format

Commands are markdown files in `.claude/commands/` that users invoke via `/command-name`.

**Location:** `.claude/commands/{command-name}.md`

```markdown
---
description: Run comprehensive code review on staged changes
arguments:
  - name: files
    description: Files or directories to review
    type: file
    required: false
  - name: focus
    description: Focus area (security, performance, all)
    type: string
    default: all
aliases: [r, cr]
---

# /review Command

Review the code for the following:

1. **Security Issues** - Injection, XSS, auth problems
2. **Performance** - N+1 queries, memory leaks
3. **Best Practices** - Naming, error handling, tests

When invoked with `--focus security`, prioritize security review.
When invoked with `--focus performance`, prioritize performance review.

Output a structured review with file:line references.
```

### Subagent File Format

Subagents are markdown files in `.claude/agents/` that define specialized AI assistants.

**Location:** `.claude/agents/{agent-name}.md`

```markdown
---
name: Code Reviewer
description: Specialized agent for thorough code review with security focus
model: claude-sonnet-4-6
maxTurns: 30
allowedTools:
  - Read
  - Glob
  - Grep
  - Bash
---

# Code Reviewer Subagent

You are a specialized code reviewer. Your role is to:

1. Analyze code for security vulnerabilities
2. Identify performance bottlenecks
3. Check adherence to project conventions
4. Suggest improvements with specific code examples

## Review Process

1. First, understand the codebase structure
2. Read the files to be reviewed
3. Check for common issues
4. Provide actionable feedback

## Output Format

For each issue found, provide:
- File and line number
- Issue description
- Suggested fix with code example
```

### Slash Command Examples

Users can invoke commands in the agent input:

```bash
# Run the review command
/review

# Review specific files
/review src/components/Button.tsx

# Review with focus area
/review --focus security

# Using alias
/cr src/
```

### Subagent Invocation

Subagents can be invoked via:

```bash
# Direct mention (if supported)
@reviewer check the authentication module

# Via Task tool (programmatic)
Task(subagent_type: "reviewer", prompt: "Review the auth module")
```

### Built-in Slash Commands

AgentPane provides these built-in commands (always available):

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | Show available commands and skills |
| `/clear` | `/c` | Clear session history |
| `/status` | `/s` | Show agent status |
| `/stop` | `/abort` | Stop current agent execution |
| `/approve` | `/a`, `/yes` | Approve pending changes |
| `/reject` | `/no` | Reject pending changes |
| `/feedback` | `/f` | Send feedback to agent |
| `/sync` | - | Sync configuration from GitHub |
| `/agents` | - | List available subagents |
| `/skills` | - | List available skills |

### Application Configuration

```typescript
// lib/config/types.ts
export interface AppConfig {
  /** Base URL for session sharing links */
  appUrl: string;

  /** PGlite database path */
  databasePath: string;

  /** Server port */
  port: number;

  /** Enable development features */
  isDevelopment: boolean;
}

export interface ConfigDefaults {
  project: ProjectConfig;
  app: AppConfig;
}

export interface MergedConfig {
  /** Environment variables */
  env: EnvConfig;

  /** Merged project settings (global + project + env) */
  project: ProjectConfig;

  /** Application configuration */
  app: AppConfig;

  /** Merged skills (global + project) */
  skills: SkillConfig[];

  /** Merged commands (global + project) */
  commands: CommandConfig[];

  /** Merged subagents (global + project) */
  subagents: SubagentConfig[];

  /** Combined CLAUDE.md instructions (global + project) */
  instructions: string;

  /** Configuration source information */
  source: ConfigSource;
}

export type ConfigSource = {
  /** Environment source (always 'environment') */
  env: 'environment';

  /** Primary project config source */
  project: 'local' | 'github' | 'global' | 'defaults';

  /** Skills sources loaded */
  skills: {
    global: number;   // Count from ~/.claude/skills/
    project: number;  // Count from {project}/.claude/skills/
  };

  /** Commands sources loaded */
  commands: {
    global: number;
    project: number;
  };

  /** Subagents sources loaded */
  subagents: {
    global: number;
    project: number;
  };

  /** Timestamp when config was loaded */
  loadedAt: Date;

  /** Git SHA for synced project config (cache invalidation) */
  repoSha?: string;

  /** Global config path */
  globalPath: string;

  /** Project config path */
  projectPath: string;
};
```

---

## Configuration Schema

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Claude API access key |
| `GITHUB_TOKEN` | No | - | Personal access token for GitHub integration |
| `DATABASE_URL` | No | `./data/agentpane.db` | Override PGlite storage path |
| `APP_URL` | No | `http://localhost:5173` | Base URL for session sharing |
| `NODE_ENV` | No | `development` | Environment mode |
| `LOG_LEVEL` | No | `info` | Logging verbosity |
| `GITHUB_APP_ID` | No | - | GitHub App ID for App authentication |
| `GITHUB_APP_NAME` | No | - | GitHub App name (URL slug) |
| `GITHUB_CLIENT_ID` | No | - | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | No | - | GitHub OAuth client secret |
| `GITHUB_PRIVATE_KEY` | No | - | GitHub App private key (PEM format) |
| `GITHUB_WEBHOOK_SECRET` | No | - | Secret for webhook signature verification |

### Zod Schemas

```typescript
// lib/config/schemas.ts
import { z } from 'zod';

// Valid Claude models
const claudeModelSchema = z.enum([
  'claude-sonnet-4-6',
  'claude-opus-4-20250514',
  'claude-haiku-3-20240307',
]).default('claude-sonnet-4-6');

// Valid tool names
const toolNameSchema = z.enum([
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'NotebookEdit',
  'TodoWrite',
  'Task',
]);

// Environment schema
export const envConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  GITHUB_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().url().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_NAME: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// Project config schema
export const projectConfigSchema = z.object({
  worktreeRoot: z.string().min(1).default('.worktrees'),

  initScript: z.string().optional(),

  envFile: z.string()
    .refine(
      (path) => !path || !path.startsWith('/'),
      'envFile must be a relative path'
    )
    .optional(),

  defaultBranch: z.string().min(1).default('main'),

  maxConcurrentAgents: z.number()
    .int()
    .min(1, 'At least 1 concurrent agent required')
    .max(10, 'Maximum 10 concurrent agents')
    .default(3),

  allowedTools: z.array(toolNameSchema)
    .min(1, 'At least one tool must be allowed')
    .default(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),

  maxTurns: z.number()
    .int()
    .min(1, 'At least 1 turn required')
    .max(500, 'Maximum 500 turns')
    .default(50),

  model: claudeModelSchema.optional(),

  systemPrompt: z.string().max(10000).optional(),

  temperature: z.number().min(0).max(1).optional(),
});

// Application config schema
export const appConfigSchema = z.object({
  appUrl: z.string().url().default('http://localhost:5173'),
  databasePath: z.string().default('./data/agentpane.db'),
  port: z.number().int().min(1).max(65535).default(5173),
  isDevelopment: z.boolean().default(true),
});

// Export types from schemas
export type EnvConfig = z.infer<typeof envConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
```

---

## Loading Order and Precedence

Configuration is loaded and merged in the following order (highest priority first):

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Environment Variables (highest priority)                 │
│    - Always override everything                             │
│    - Source: process.env                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Local Project Config                                     │
│    - Path: {projectPath}/.claude/settings.json             │
│    - Watched for hot-reload                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. GitHub Repository Config (if synced)                     │
│    - Path: .claude/settings.json in repo                   │
│    - Synced via webhook on push                             │
│    - Cached in repository_configs table                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Application Defaults (lowest priority)                   │
│    - Hard-coded fallbacks                                   │
│    - Ensures all fields have values                         │
└─────────────────────────────────────────────────────────────┘
```

### Merge Algorithm

```typescript
// lib/config/merge.ts
import { deepMerge } from '@/lib/utils/deep-merge';
import type { ProjectConfig, MergedConfig, ConfigSource, GlobalConfig } from './types';

/**
 * Merges configuration from all sources with proper precedence:
 * 1. Environment variables (highest)
 * 2. Project local config ({project}/.claude/)
 * 3. GitHub synced config (if enabled)
 * 4. Global user config (~/.claude/)
 * 5. Application defaults (lowest)
 */
export function mergeConfigs(
  defaults: ProjectConfig,
  globalConfig: Partial<ProjectConfig> | null,
  githubConfig: Partial<ProjectConfig> | null,
  localConfig: Partial<ProjectConfig> | null,
  envOverrides: Partial<ProjectConfig>
): { config: ProjectConfig; source: ConfigSource['project'] } {
  // Determine primary source (for UI display)
  let source: ConfigSource['project'] = 'defaults';

  // Start with defaults
  let merged = { ...defaults };

  // Apply global user config (~/.claude/settings.json)
  if (globalConfig) {
    merged = deepMerge(merged, globalConfig);
    source = 'global';
  }

  // Apply GitHub synced config (overrides global)
  if (githubConfig) {
    merged = deepMerge(merged, githubConfig);
    source = 'github';
  }

  // Apply local project config (overrides GitHub)
  if (localConfig) {
    merged = deepMerge(merged, localConfig);
    source = 'local';
  }

  // Apply environment overrides (always highest priority)
  merged = deepMerge(merged, envOverrides);

  return { config: merged, source };
}

/**
 * Merges skills from global and project sources.
 * Project skills override global skills with the same ID.
 */
export function mergeSkills(
  globalSkills: SkillConfig[],
  projectSkills: SkillConfig[]
): SkillConfig[] {
  const skillMap = new Map<string, SkillConfig>();

  // Add global skills first
  for (const skill of globalSkills) {
    skillMap.set(skill.id, { ...skill, source: { type: 'global', path: skill.source.path } });
  }

  // Project skills override global
  for (const skill of projectSkills) {
    skillMap.set(skill.id, skill);
  }

  return Array.from(skillMap.values());
}

/**
 * Merges commands from global and project sources.
 * Project commands override global commands with the same name.
 */
export function mergeCommands(
  globalCommands: CommandConfig[],
  projectCommands: CommandConfig[]
): CommandConfig[] {
  const commandMap = new Map<string, CommandConfig>();

  // Add global commands first
  for (const cmd of globalCommands) {
    commandMap.set(cmd.command, cmd);
  }

  // Project commands override global
  for (const cmd of projectCommands) {
    commandMap.set(cmd.command, cmd);
  }

  return Array.from(commandMap.values());
}

/**
 * Merges subagents from global and project sources.
 * Project agents override global agents with the same ID.
 */
export function mergeSubagents(
  globalAgents: SubagentConfig[],
  projectAgents: SubagentConfig[]
): SubagentConfig[] {
  const agentMap = new Map<string, SubagentConfig>();

  // Add global agents first
  for (const agent of globalAgents) {
    agentMap.set(agent.id, agent);
  }

  // Project agents override global
  for (const agent of projectAgents) {
    agentMap.set(agent.id, agent);
  }

  return Array.from(agentMap.values());
}
```

---

## Validation Rules

### Environment Validation

```typescript
// lib/config/validate-env.ts
import { envConfigSchema } from './schemas';
import { ok, err } from '@/lib/utils/result';
import { ConfigErrors } from '@/lib/errors/config-errors';
import type { Result } from '@/lib/utils/result';
import type { EnvConfig } from './types';
import type { ConfigError } from '@/lib/errors/config-errors';

export function validateEnv(): Result<EnvConfig, ConfigError> {
  const parsed = envConfigSchema.safeParse(process.env);

  if (!parsed.success) {
    const missingRequired = parsed.error.errors
      .filter(e => e.path[0] === 'ANTHROPIC_API_KEY')
      .map(e => e.path.join('.'));

    if (missingRequired.length > 0) {
      return err(ConfigErrors.MISSING_REQUIRED(missingRequired));
    }

    return err(ConfigErrors.VALIDATION_FAILED(
      parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
    ));
  }

  return ok(parsed.data);
}
```

### Project Config Validation

```typescript
// lib/config/validate-project.ts
import { projectConfigSchema } from './schemas';
import { ok, err } from '@/lib/utils/result';
import { ConfigErrors } from '@/lib/errors/config-errors';
import type { Result } from '@/lib/utils/result';
import type { ProjectConfig } from './types';
import type { ConfigError } from '@/lib/errors/config-errors';

export function validateProjectConfig(config: unknown): Result<ProjectConfig, ConfigError> {
  const parsed = projectConfigSchema.safeParse(config);

  if (!parsed.success) {
    return err(ConfigErrors.VALIDATION_FAILED(
      parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
    ));
  }

  // Additional business logic validation
  const validatedConfig = parsed.data;

  // Validate tool dependencies
  if (validatedConfig.allowedTools.includes('Edit') &&
      !validatedConfig.allowedTools.includes('Read')) {
    return err(ConfigErrors.VALIDATION_FAILED([
      'Edit tool requires Read tool to be allowed'
    ]));
  }

  return ok(validatedConfig);
}
```

### Secret Detection

```typescript
// lib/config/validate-secrets.ts
import { ConfigErrors } from '@/lib/errors/config-errors';
import type { Result } from '@/lib/utils/result';
import type { ConfigError } from '@/lib/errors/config-errors';

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
];

export function detectSecrets(config: Record<string, unknown>): Result<void, ConfigError> {
  const detectedSecrets: string[] = [];

  function checkValue(key: string, value: unknown, path: string[]): void {
    const currentPath = [...path, key].join('.');

    if (typeof value === 'string' && value.length > 0) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(key)) {
          detectedSecrets.push(currentPath);
          break;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        checkValue(k, v, [...path, key]);
      }
    }
  }

  for (const [key, value] of Object.entries(config)) {
    checkValue(key, value, []);
  }

  if (detectedSecrets.length > 0) {
    return err(ConfigErrors.SECRETS_DETECTED(detectedSecrets));
  }

  return ok(undefined);
}
```

---

## Implementation Outline

### ConfigService Class

```typescript
// lib/config/config-service.ts
import { readFile, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, err } from '@/lib/utils/result';
import { ConfigErrors } from '@/lib/errors/config-errors';
import { validateEnv } from './validate-env';
import { validateProjectConfig } from './validate-project';
import { detectSecrets } from './validate-secrets';
import { mergeConfigs } from './merge';
import { projectConfigSchema, appConfigSchema } from './schemas';
import { db } from '@/db/client';
import { projects, repositoryConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Result } from '@/lib/utils/result';
import type {
  IConfigService,
  EnvConfig,
  ProjectConfig,
  AppConfig,
  MergedConfig,
  ConfigDefaults,
} from './types';
import type { ConfigError } from '@/lib/errors/config-errors';

const CONFIG_FILE_NAME = 'settings.json';
const CONFIG_DIR_NAME = '.claude';

export class ConfigService implements IConfigService {
  private envCache: EnvConfig | null = null;
  private projectConfigCache = new Map<string, ProjectConfig>();
  private watchers = new Map<string, () => void>();

  // ─────────────────────────────────────────────────────────────────
  // Environment Variables
  // ─────────────────────────────────────────────────────────────────

  getEnv<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
    if (!this.envCache) {
      const result = this.validateEnv();
      if (!result.ok) {
        throw new Error(`Environment validation failed: ${result.error.message}`);
      }
      this.envCache = result.value;
    }
    return this.envCache[key];
  }

  validateEnv(): Result<EnvConfig, ConfigError> {
    return validateEnv();
  }

  // ─────────────────────────────────────────────────────────────────
  // Project Configuration
  // ─────────────────────────────────────────────────────────────────

  async loadProjectConfig(projectPath: string): Promise<Result<ProjectConfig, ConfigError>> {
    // Check cache first
    if (this.projectConfigCache.has(projectPath)) {
      return ok(this.projectConfigCache.get(projectPath)!);
    }

    const configPath = join(projectPath, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Check for secrets in config file
      const secretCheck = detectSecrets(parsed);
      if (!secretCheck.ok) {
        return err(secretCheck.error);
      }

      // Validate config
      const validationResult = validateProjectConfig(parsed);
      if (!validationResult.ok) {
        return err(validationResult.error);
      }

      // Cache the result
      this.projectConfigCache.set(projectPath, validationResult.value);

      return ok(validationResult.value);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // No config file, return defaults
        const defaults = this.getDefaults().project;
        this.projectConfigCache.set(projectPath, defaults);
        return ok(defaults);
      }

      if (error instanceof SyntaxError) {
        return err(ConfigErrors.PARSE_ERROR(configPath, error.message));
      }

      return err(ConfigErrors.LOAD_FAILED(configPath, String(error)));
    }
  }

  validateProjectConfig(config: unknown): Result<ProjectConfig, ConfigError> {
    return validateProjectConfig(config);
  }

  watchProjectConfig(projectPath: string, onChange: (config: ProjectConfig) => void): () => void {
    const configPath = join(projectPath, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    // Set up file watcher
    const abortController = new AbortController();

    (async () => {
      try {
        const watcher = watch(configPath, { signal: abortController.signal });

        for await (const event of watcher) {
          if (event.eventType === 'change') {
            // Invalidate cache
            this.projectConfigCache.delete(projectPath);

            // Reload and notify
            const result = await this.loadProjectConfig(projectPath);
            if (result.ok) {
              onChange(result.value);
            }
          }
        }
      } catch (error: unknown) {
        // Watcher was aborted or file was deleted
        if ((error as Error).name !== 'AbortError') {
          console.error('[ConfigService] Watch error:', error);
        }
      }
    })();

    // Return cleanup function
    const cleanup = () => {
      abortController.abort();
      this.watchers.delete(projectPath);
    };

    this.watchers.set(projectPath, cleanup);

    return cleanup;
  }

  // ─────────────────────────────────────────────────────────────────
  // Application Configuration
  // ─────────────────────────────────────────────────────────────────

  getAppConfig(): AppConfig {
    const env = this.validateEnv();
    if (!env.ok) {
      return this.getDefaults().app;
    }

    return {
      appUrl: env.value.APP_URL ?? 'http://localhost:5173',
      databasePath: env.value.DATABASE_URL ?? './data/agentpane.db',
      port: 5173,
      isDevelopment: env.value.NODE_ENV === 'development',
    };
  }

  getDefaults(): ConfigDefaults {
    return {
      project: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        maxConcurrentAgents: 3,
        allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
        maxTurns: 50,
      },
      app: {
        appUrl: 'http://localhost:5173',
        databasePath: './data/agentpane.db',
        port: 5173,
        isDevelopment: true,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Merged Configuration
  // ─────────────────────────────────────────────────────────────────

  async getMergedConfig(projectId: string): Promise<Result<MergedConfig, ConfigError>> {
    // 1. Validate environment
    const envResult = this.validateEnv();
    if (!envResult.ok) {
      return err(envResult.error);
    }

    // 2. Get project from database
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) {
      return err(ConfigErrors.PROJECT_NOT_FOUND(projectId));
    }

    // 3. Load local config
    const localResult = await this.loadProjectConfig(project.path);
    const localConfig = localResult.ok ? localResult.value : null;

    // 4. Get GitHub config if available
    let githubConfig: Partial<ProjectConfig> | null = null;
    if (project.githubOwner && project.githubRepo) {
      const repoConfig = await db.query.repositoryConfigs.findFirst({
        where: eq(repositoryConfigs.fullName, `${project.githubOwner}/${project.githubRepo}`),
      });

      if (repoConfig?.config) {
        githubConfig = repoConfig.config as Partial<ProjectConfig>;
      }
    }

    // 5. Build environment overrides
    const envOverrides: Partial<ProjectConfig> = {};
    // Environment variables can override specific project settings
    // (Add mapping logic as needed)

    // 6. Merge all configs
    const defaults = this.getDefaults().project;
    const { config: mergedProject, source } = mergeConfigs(
      defaults,
      githubConfig,
      localConfig,
      envOverrides
    );

    return ok({
      env: envResult.value,
      project: mergedProject,
      app: this.getAppConfig(),
      source: {
        env: 'environment',
        project: source,
        loadedAt: new Date(),
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────

  dispose(): void {
    for (const cleanup of this.watchers.values()) {
      cleanup();
    }
    this.watchers.clear();
    this.projectConfigCache.clear();
    this.envCache = null;
  }
}

// Export singleton instance
export const configService = new ConfigService();
```

---

## Configuration Errors

```typescript
// lib/errors/config-errors.ts
import { createError } from './base';

export const ConfigErrors = {
  MISSING_REQUIRED: (variables: string[]) => createError(
    'CONFIG_MISSING_REQUIRED',
    `Missing required configuration: ${variables.join(', ')}`,
    500,
    { missingVariables: variables }
  ),

  VALIDATION_FAILED: (errors: string[]) => createError(
    'CONFIG_VALIDATION_FAILED',
    'Configuration validation failed',
    400,
    { validationErrors: errors }
  ),

  PARSE_ERROR: (path: string, error: string) => createError(
    'CONFIG_PARSE_ERROR',
    `Failed to parse configuration file: ${path}`,
    400,
    { path, parseError: error }
  ),

  LOAD_FAILED: (path: string, error: string) => createError(
    'CONFIG_LOAD_FAILED',
    `Failed to load configuration from: ${path}`,
    500,
    { path, error }
  ),

  SECRETS_DETECTED: (paths: string[]) => createError(
    'CONFIG_SECRETS_DETECTED',
    'Potential secrets detected in configuration file',
    400,
    {
      detectedPaths: paths,
      hint: 'Secrets should be stored in environment variables, not config files'
    }
  ),

  PROJECT_NOT_FOUND: (projectId: string) => createError(
    'CONFIG_PROJECT_NOT_FOUND',
    `Project not found: ${projectId}`,
    404,
    { projectId }
  ),

  HOT_RELOAD_FAILED: (path: string, error: string) => createError(
    'CONFIG_HOT_RELOAD_FAILED',
    `Hot reload failed for: ${path}`,
    500,
    { path, error }
  ),
} as const;

export type ConfigError =
  | ReturnType<typeof ConfigErrors.MISSING_REQUIRED>
  | ReturnType<typeof ConfigErrors.VALIDATION_FAILED>
  | ReturnType<typeof ConfigErrors.PARSE_ERROR>
  | ReturnType<typeof ConfigErrors.LOAD_FAILED>
  | ReturnType<typeof ConfigErrors.SECRETS_DETECTED>
  | ReturnType<typeof ConfigErrors.PROJECT_NOT_FOUND>
  | ReturnType<typeof ConfigErrors.HOT_RELOAD_FAILED>;
```

---

## Hot-Reload Support

### File Watching

```typescript
// lib/config/hot-reload.ts
import { configService } from './config-service';
import { eventBus } from '@/lib/events/event-bus';

export interface HotReloadOptions {
  projectPath: string;
  onConfigChange?: (config: ProjectConfig) => void;
  onError?: (error: Error) => void;
}

export function setupHotReload(options: HotReloadOptions): () => void {
  const { projectPath, onConfigChange, onError } = options;

  const cleanup = configService.watchProjectConfig(projectPath, (newConfig) => {
    try {
      // Emit event for other components
      eventBus.emit('config:changed', {
        projectPath,
        config: newConfig,
        timestamp: new Date(),
      });

      // Call user callback
      onConfigChange?.(newConfig);

      console.log(`[HotReload] Config reloaded for: ${projectPath}`);
    } catch (error) {
      onError?.(error as Error);
    }
  });

  return cleanup;
}
```

### Event Integration

```typescript
// lib/events/config-events.ts
export interface ConfigChangedEvent {
  type: 'config:changed';
  projectPath: string;
  config: ProjectConfig;
  timestamp: Date;
}

// Agents should listen for config changes and apply non-disruptive updates
// Running agents continue with existing config until completion
// New agent executions use the updated config
```

---

## Security Considerations

### Secret Storage Policy

**Environment Variables Only:** All secrets MUST be stored in environment variables, never in configuration files.

| Secret Type | Variable Name | Storage |
|-------------|---------------|---------|
| Claude API Key | `ANTHROPIC_API_KEY` | Environment |
| GitHub Token | `GITHUB_TOKEN` | Environment |
| GitHub App Secret | `GITHUB_CLIENT_SECRET` | Environment |
| GitHub Private Key | `GITHUB_PRIVATE_KEY` | Environment |
| Webhook Secret | `GITHUB_WEBHOOK_SECRET` | Environment |

### Config File Rules

1. **No secrets in config files** - Validation rejects configs containing secret-like keys
2. **No absolute paths** - `envFile` must be relative to prevent path traversal
3. **Tool whitelist only** - `allowedTools` validates against known tool names
4. **Bounded values** - `maxTurns`, `maxConcurrentAgents` have min/max limits

---

## Config File Examples

### Minimal Project Config

```json
// .claude/settings.json
{
  "defaultBranch": "main",
  "maxConcurrentAgents": 3
}
```

### Full Project Config

```json
// .claude/settings.json
{
  "worktreeRoot": ".worktrees",
  "initScript": "bun install && bun run db:migrate",
  "envFile": ".env.development",
  "defaultBranch": "main",
  "maxConcurrentAgents": 6,
  "allowedTools": ["Read", "Edit", "Bash", "Glob", "Grep", "WebSearch"],
  "maxTurns": 100,
  "model": "claude-sonnet-4-6",
  "systemPrompt": "You are a helpful coding assistant for this project.",
  "temperature": 0.7,
  "skills": ["code-review", "testing", "docs"]
}
```

### Example Skill Files

**`.claude/skills/testing.md`** - Test generation skill:

```markdown
---
name: Test Generation
description: Generate comprehensive tests for code changes
slashCommand:
  command: test
  aliases: [t]
  arguments:
    - name: path
      description: File or directory to generate tests for
      type: file
      required: false
    - name: type
      description: Test type (unit, integration, e2e)
      type: string
      default: unit
---

# Test Generation Skill

Generate comprehensive tests following project conventions.

## Guidelines

1. **Test Framework**: Use the project's existing test framework (check package.json)
2. **Coverage**: Aim for edge cases, error conditions, and happy paths
3. **Naming**: Follow `describe/it` or `test` conventions based on project style
4. **Mocking**: Use minimal mocking, prefer integration-style tests
5. **Assertions**: Use specific assertions (toBe, toEqual, toThrow)

## Output Format

Create test files adjacent to source files with `.test.ts` or `.spec.ts` suffix.

When generating tests:
- Read existing test files to understand patterns
- Check for test utilities or fixtures
- Follow existing describe/it structure
- Include setup/teardown when needed
```

**`.claude/skills/refactor.md`** - Refactoring skill:

```markdown
---
name: Refactoring Assistant
description: Safe, incremental code refactoring with test verification
slashCommand:
  command: refactor
  aliases: [rf]
  arguments:
    - name: target
      description: Function, class, or file to refactor
      type: string
      required: true
    - name: strategy
      description: Refactoring strategy (extract, inline, rename, simplify)
      type: string
      default: simplify
---

# Refactoring Skill

Perform safe, incremental refactoring with verification.

## Process

1. **Analyze**: Understand current implementation and dependencies
2. **Plan**: Identify specific refactoring steps
3. **Verify**: Run tests before and after each change
4. **Commit**: Create atomic commits for each refactoring step

## Safety Rules

- Never change behavior, only structure
- Run tests after each modification
- Keep commits small and reversible
- Document breaking changes in PR description
```

### Environment File (.env)

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional
GITHUB_TOKEN=ghp_...
DATABASE_URL=./data/agentpane.db
APP_URL=http://localhost:5173

# GitHub App (optional)
GITHUB_APP_ID=123456
GITHUB_APP_NAME=my-agentpane
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=whsec_abc123

# Development
NODE_ENV=development
LOG_LEVEL=debug
```

---

## Result Type Pattern

All configuration methods use the standard Result type for error handling:

```typescript
// lib/utils/result.ts
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### Usage Example

```typescript
// Example: Loading merged config for agent execution
import { configService } from '@/lib/config/config-service';

async function startAgent(projectId: string, taskId: string) {
  const configResult = await configService.getMergedConfig(projectId);

  if (!configResult.ok) {
    console.error('Config error:', configResult.error.message);
    return err(configResult.error);
  }

  const { project, env } = configResult.value;

  // Use configuration
  const agent = new Agent({
    apiKey: env.ANTHROPIC_API_KEY,
    model: project.model ?? 'claude-sonnet-4-6',
    maxTurns: project.maxTurns,
    allowedTools: project.allowedTools,
  });

  // ...
}
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Project Service](../services/project-service.md) | Uses `validateConfig` and `updateConfig` methods |
| [GitHub App](../integrations/github-app.md) | Syncs config from `.claude/settings.json` in repos |
| [Database Schema](../database/schema.md) | `projects.config` JSONB stores validated ProjectConfig |
| [Agent Service](../services/agent-service.md) | Reads merged config for agent execution parameters |
| [Error Catalog](../errors/error-catalog.md) | ConfigError types defined here |
| [Worktree Service](../services/worktree-service.md) | Uses `worktreeRoot`, `initScript`, `envFile` settings |
