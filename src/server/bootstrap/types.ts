/**
 * Bootstrap Types
 *
 * Shared type definitions for the server bootstrap pipeline.
 */

import type { Database as BunSQLite } from 'bun:sqlite';
import type postgres from 'postgres';
import type { EventEmittingSandboxProvider } from '../../lib/sandbox/providers/sandbox-provider.js';
import type { AgentService } from '../../services/agent.service.js';
import type { ApiKeyService } from '../../services/api-key.service.js';
import type { CliMonitorService } from '../../services/cli-monitor/index.js';
import type { CodespaceService } from '../../services/codespace.service.js';
import type { createContainerAgentService } from '../../services/container-agent.service.js';
import type { DurableStreamsService } from '../../services/durable-streams.service.js';
import type { EventProcessingService } from '../../services/event-processing.service.js';
import type { EventSourceService } from '../../services/event-source.service.js';
import type { EventSubscriptionService } from '../../services/event-subscription.service.js';
import type { GitService } from '../../services/git.service.js';
import type { GitHubAppService } from '../../services/github-app.service.js';
import type { GitHubTokenService } from '../../services/github-token.service.js';
import type { MarketplaceService } from '../../services/marketplace.service.js';
import type { DreamService } from '../../services/memory/dream.service.js';
import type { MemoryService } from '../../services/memory/index.js';
import type { SkillTrackingService } from '../../services/memory/skill-tracking.service.js';
import type { ProjectFolderService } from '../../services/project-folder.service.js';
import type { SandboxConfigService } from '../../services/sandbox-config.service.js';
import type { SchedulerService } from '../../services/scheduler.service.js';
import type { SessionService } from '../../services/session.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import type { TaskService } from '../../services/task.service.js';
import type { TaskCreationService } from '../../services/task-creation.service.js';
import type { TemplateService } from '../../services/template.service.js';
import type { TerraformComposeService } from '../../services/terraform-compose.service.js';
import type { TerraformRegistryService } from '../../services/terraform-registry.service.js';
import type { WorkflowService } from '../../services/workflow.service.js';
import type { CommandRunner, WorktreeService } from '../../services/worktree.service.js';
import type { Database } from '../../types/database.js';
import type { SandboxProviderHealth } from '../router.js';

/** Validated server configuration from environment variables. */
export interface ServerConfig {
  dbMode: 'sqlite' | 'postgres';
  databaseUrl?: string;
  dbPath: string;
  port: number;
  corsOrigin: string;
  logLevel: string;
  nodeEnv: string;
  skipAuth: boolean;
  sandboxInitTimeoutMs: number;
  caddyStreamsUrl: string;
  /** PostgreSQL connection pool / client configuration (F02-05). */
  postgres: PostgresClientConfig;
}

/** PostgreSQL connection pool / client configuration. */
export interface PostgresClientConfig {
  /** Maximum number of connections in the pool. */
  max: number;
  /** Seconds a connection may remain idle before being closed. 0 disables idle close. */
  idleTimeoutSeconds: number;
  /** Maximum lifetime of a connection in seconds. 0 disables. */
  maxLifetimeSeconds: number;
  /** Seconds to wait for a new connection before giving up. */
  connectTimeoutSeconds: number;
  /** Value set on `application_name` for pg_stat_activity. */
  applicationName: string;
  /** SSL configuration: 'disable' | 'require' | 'prefer'. Undefined means driver default. */
  ssl?: 'disable' | 'require' | 'prefer';
}

/** Database initialization result. */
export interface DatabaseResult {
  db: Database;
  sqlite: InstanceType<typeof BunSQLite> | null;
  pgClient: ReturnType<typeof postgres> | null;
}

/** Service container holding all initialized services. */
export interface ServiceContainer {
  githubService: GitHubTokenService;
  apiKeyService: ApiKeyService;
  templateService: TemplateService;
  sandboxConfigService: SandboxConfigService;
  taskService: TaskService;
  sessionService: SessionService;
  taskCreationService: TaskCreationService;
  worktreeService: WorktreeService;
  marketplaceService: MarketplaceService;
  agentService: AgentService;
  workflowService: WorkflowService;
  gitService: GitService;
  codespaceService: CodespaceService;
  projectFolderService: ProjectFolderService;
  cliMonitorService: CliMonitorService;
  durableStreamsService: DurableStreamsService;
  terraformRegistryService: TerraformRegistryService;
  terraformComposeService: TerraformComposeService;
  settingsService: SettingsService;
  githubAppService: GitHubAppService;
  eventSourceService: EventSourceService;
  eventSubscriptionService: EventSubscriptionService;
  eventProcessingService: EventProcessingService;
  schedulerService: SchedulerService;
  commandRunner: CommandRunner;
  containerAgentService: ReturnType<typeof createContainerAgentService> | null;
  memoryService: MemoryService;
  skillTrackingService: SkillTrackingService;
  dreamService: DreamService;
}

/** Mutable sandbox state shared across bootstrap phases and runtime. */
export interface SandboxState {
  provider: EventEmittingSandboxProvider | null;
  containerAgentService: ReturnType<typeof createContainerAgentService> | null;
  k8sProvider: ReturnType<
    typeof import('../../lib/sandbox/providers/agent-sandbox-provider.js').createAgentSandboxProvider
  > | null;
  nomadProvider:
    | import('../../lib/sandbox/providers/nomad-sandbox-provider.js').NomadSandboxProvider
    | null;
  controller:
    | import('../../lib/sandbox/controllers/sandbox-controller.js').SandboxController
    | null;
  k8sHealInterval: ReturnType<typeof setInterval> | null;
  nomadHealInterval: ReturnType<typeof setInterval> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  initializing: boolean;
  /**
   * Set to `true` once the sandbox reconciliation phase has completed
   * (F01-01). Used by the `/api/health` readiness gate (F01-03) to avoid
   * returning 200 until live containers have been cross-referenced with
   * the `sandbox_instances` DB table.
   */
  reconciled: boolean;
}

/**
 * Result of a bootstrap phase (F01-05).
 *
 * Each phase returns this explicitly so the orchestrator can apply a uniform
 * policy: `fatal: true` terminates the process via `process.exit(1)`;
 * `fatal: false` logs the error and continues. This replaces the previous
 * inconsistent handling where some phases called `process.exit` directly,
 * some logged and continued, and some swallowed errors silently.
 */
export type BootstrapPhaseResult = { ok: true } | { ok: false; fatal: boolean; error: Error };

/** Bootstrap context passed through phases. */
export interface BootstrapContext {
  config: ServerConfig;
  database: DatabaseResult;
  services: ServiceContainer;
  sandbox: SandboxState;
  getSandboxProvider: () => EventEmittingSandboxProvider | null;
  getK8sProvider: () => SandboxProviderHealth | null;
  getNomadProvider: () => SandboxProviderHealth | null;
}
