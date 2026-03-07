/**
 * Bun API Server
 *
 * Handles API requests that need database access.
 * Runs alongside Vite dev server.
 */

import { createLogger } from '../lib/logging/logger.js';
import { CaddyDurableStreamsServer } from '../lib/streams/caddy-producer.js';

const log = createLogger('APIServer');

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception', { error });
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled Rejection', { error: reason });
});

// Validate required environment variables at startup (non-secret settings only)
function validateEnv() {
  const warnings: string[] = [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !process.env.CORS_ORIGIN) {
    warnings.push('CORS_ORIGIN not set — defaulting to http://localhost:3000');
  }

  for (const w of warnings) {
    log.warn(w);
  }

  log.info('Environment validated', {
    data: {
      nodeEnv: process.env.NODE_ENV ?? 'development',
      corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    },
  });
}

validateEnv();

import { Database as BunSQLite } from 'bun:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as pgSchema from '../db/schema/postgres/index.js';
import * as sqliteSchema from '../db/schema/sqlite/index.js';
import {
  CLI_SESSIONS_MIGRATION_SQL,
  CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL,
  EVENT_SYSTEM_MIGRATION_SQL,
  MIGRATION_SQL,
  PERFORMANCE_INDEXES_MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
  RBAC_SCHEMA_ADDITIONS,
  SANDBOX_CONTAINER_ID_MIGRATION_SQL,
  SANDBOX_MIGRATION_SQL,
  SCHEDULE_EXECUTIONS_MIGRATION_SQL,
  seedDefaultTeamForExistingTokens,
  TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL,
  TERRAFORM_MIGRATION_SQL,
} from '../lib/bootstrap/phases/schema.js';
import { decryptToken } from '../lib/crypto/server-encryption.js';
import { PluginRegistry } from '../lib/events/plugin-registry.js';
import { CronEventSourcePlugin } from '../lib/events/plugins/cron-plugin.js';
import { GitHubEventSourcePlugin } from '../lib/events/plugins/github.js';
import { SandboxController } from '../lib/sandbox/controllers/sandbox-controller.js';
import { createDockerProvider } from '../lib/sandbox/index.js';
import { createAgentSandboxProvider } from '../lib/sandbox/providers/agent-sandbox-provider.js';
import type { EventEmittingSandboxProvider } from '../lib/sandbox/providers/sandbox-provider.js';
import type { SandboxConfig } from '../lib/sandbox/types.js';
import { SANDBOX_DEFAULTS } from '../lib/sandbox/types.js';
import { AgentService } from '../services/agent.service.js';
import { ApiKeyService } from '../services/api-key.service.js';
import { CliMonitorService } from '../services/cli-monitor/index.js';
import { createContainerAgentService } from '../services/container-agent.service.js';
import { DurableStreamsService } from '../services/durable-streams.service.js';
import { EventProcessingService } from '../services/event-processing.service.js';
import { EventSourceService } from '../services/event-source.service.js';
import { EventSubscriptionService } from '../services/event-subscription.service.js';
import { GitHubTokenService } from '../services/github-token.service.js';
import { MarketplaceService } from '../services/marketplace.service.js';
import { SandboxConfigService } from '../services/sandbox-config.service.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { SessionService } from '../services/session.service.js';
import { SettingsService } from '../services/settings.service.js';
import { TaskService } from '../services/task.service.js';
import {
  createTaskCreationService,
  type TaskCreationService,
} from '../services/task-creation.service.js';
import { TemplateService } from '../services/template.service.js';
import { startSyncScheduler } from '../services/template-sync-scheduler.js';
import { TerraformComposeService } from '../services/terraform-compose.service.js';
import { TerraformRegistryService } from '../services/terraform-registry.service.js';
import { startTerraformSyncScheduler } from '../services/terraform-sync-scheduler.js';
import { type CommandRunner, WorktreeService } from '../services/worktree.service.js';
import type { Database } from '../types/database.js';
import { createRouter } from './router.js';

declare const Bun: {
  spawn: (
    cmd: string[],
    options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' }
  ) => {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
  serve: (options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
    idleTimeout?: number;
  }) => void;
};

// Database initialization — supports SQLite (default) and PostgreSQL modes
const DB_MODE = process.env.DB_MODE ?? 'sqlite';
log.info(`Database mode: ${DB_MODE}`);

// Use SQLite schema tables for type compatibility with Database (= SqliteDatabase).
// At runtime the table definitions are structurally identical across both schemas.
const schemaTables = {
  agents: sqliteSchema.agents,
  tasks: sqliteSchema.tasks,
  settings: sqliteSchema.settings,
  worktrees: sqliteSchema.worktrees,
  sessions: sqliteSchema.sessions,
};

/** Return the number of rows affected by an update/delete, handling both SQLite and PG results */
function getChangedCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return (result as { changes?: number })?.changes ?? 0;
}

let db: Database;
let sqlite: InstanceType<typeof BunSQLite> | null = null;
let pgClient: ReturnType<typeof postgres> | null = null;

if (DB_MODE === 'postgres') {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    log.error('DATABASE_URL is required when DB_MODE=postgres');
    process.exit(1);
  }
  pgClient = postgres(connectionString);
  db = drizzlePg(pgClient, { schema: pgSchema }) as unknown as Database;

  // Run Drizzle Kit migrations (reuse the existing drizzle instance)
  await migratePg(db as unknown as ReturnType<typeof drizzlePg>, {
    migrationsFolder: './src/db/migrations-pg',
  });
  log.info('PostgreSQL migrations applied');
} else {
  // Existing SQLite initialization (unchanged)
  const DB_PATH = process.env.DB_PATH ?? './data/agentpane.db';
  sqlite = new BunSQLite(DB_PATH);

  // Enable WAL mode for better concurrent read performance and crash recovery
  sqlite.exec('PRAGMA journal_mode=WAL');
  sqlite.exec('PRAGMA busy_timeout=5000');
  sqlite.exec('PRAGMA foreign_keys=ON');
  log.info('SQLite WAL mode enabled', { data: { dbPath: DB_PATH } });

  // Run migrations to ensure schema is up to date
  sqlite.exec(MIGRATION_SQL);
  log.info('Schema migrations applied');

  // Run sandbox migration (may fail if column already exists)
  try {
    sqlite.exec(SANDBOX_MIGRATION_SQL);
    log.info('[API Server] Sandbox migration applied');
  } catch (error) {
    // Only warn for unexpected errors - duplicate column errors are expected on subsequent runs
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      console.warn(
        '[API Server] Sandbox migration error (unexpected):',
        error instanceof Error ? error.message : String(error)
      );
    }
    // Silently ignore duplicate column errors (expected when migration already applied)
  }

  // Run sandbox container ID migration (may fail if column already exists)
  try {
    sqlite.exec(SANDBOX_CONTAINER_ID_MIGRATION_SQL);
    log.info('[API Server] Sandbox container ID migration applied');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      console.warn(
        '[API Server] Sandbox container ID migration error (unexpected):',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Run template sync interval migration (may fail if columns already exist)
  try {
    sqlite.exec(TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL);
    log.info('[API Server] Template sync interval migration applied');
  } catch (error) {
    // Only warn for unexpected errors - duplicate column errors are expected on subsequent runs
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      console.warn(
        '[API Server] Template sync interval migration error (unexpected):',
        error instanceof Error ? error.message : String(error)
      );
    }
    // Silently ignore duplicate column errors (expected when migration already applied)
  }

  // Apply performance indexes (idempotent — uses IF NOT EXISTS)
  sqlite.exec(PERFORMANCE_INDEXES_MIGRATION_SQL);
  log.info('Performance indexes applied');

  // Apply CLI sessions migration (idempotent — uses IF NOT EXISTS)
  sqlite.exec(CLI_SESSIONS_MIGRATION_SQL);
  log.info('CLI sessions migration applied');

  // Add performance_metrics column to cli_sessions (may fail if column already exists)
  try {
    sqlite.exec(CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL);
    log.info('CLI sessions performance_metrics migration applied');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      log.warn('CLI sessions performance_metrics migration error (unexpected)', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Apply Terraform tables migration (idempotent — uses IF NOT EXISTS)
  sqlite.exec(TERRAFORM_MIGRATION_SQL);
  log.info('Terraform migration applied');

  // Apply RBAC tables migration (idempotent — uses IF NOT EXISTS)
  sqlite.exec(RBAC_MIGRATION_SQL);
  log.info('RBAC migration applied');

  // Apply RBAC schema additions for existing databases (tags.updated_at,
  // project_tags.assigned_at, task_tags.assigned_at). Each runs individually
  // so a duplicate-column error on one doesn't block the others.
  for (const alterSql of RBAC_SCHEMA_ADDITIONS) {
    try {
      sqlite.exec(alterSql);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
        log.warn('RBAC schema addition migration error (unexpected)', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  // Apply github_tokens team_id column migration
  try {
    sqlite.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
    log.info('GitHub tokens team_id migration applied');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      log.warn('GitHub tokens team_id migration error (unexpected)', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Seed default team for existing installations with orphaned github_tokens
  seedDefaultTeamForExistingTokens(sqlite);

  // Nomad sandbox columns — run individually for partial-failure safety
  const nomadColumns = [
    `ALTER TABLE sandbox_configs ADD COLUMN nomad_address TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN nomad_token TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN nomad_namespace TEXT DEFAULT 'default'`,
    `ALTER TABLE sandbox_configs ADD COLUMN nomad_datacenter TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN nomad_region TEXT`,
  ];
  for (const sql of nomadColumns) {
    try {
      sqlite.exec(sql);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
        log.warn('Nomad migration error', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  // AgentCore sandbox columns — run individually for partial-failure safety
  const agentcoreColumns = [
    `ALTER TABLE sandbox_configs ADD COLUMN aws_access_key_id TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN aws_secret_access_key TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN aws_region TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN agentcore_runtime_arn TEXT`,
    `ALTER TABLE sandbox_configs ADD COLUMN ecr_repository_uri TEXT`,
  ];
  for (const sql of agentcoreColumns) {
    try {
      sqlite.exec(sql);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
        log.warn('AgentCore migration error', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  // Apply agents parent_agent_id migration (may fail if column already exists)
  try {
    sqlite.exec(
      `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;`
    );
    log.info('[API Server] Agents parent_agent_id migration applied');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
      log.warn('Agents parent_agent_id migration error (unexpected)', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Apply event system migration (idempotent — uses IF NOT EXISTS)
  sqlite.exec(EVENT_SYSTEM_MIGRATION_SQL);
  log.info('Event system migration applied');

  // Apply schedule executions migration (idempotent — uses IF NOT EXISTS)
  sqlite.exec(SCHEDULE_EXECUTIONS_MIGRATION_SQL);
  log.info('Schedule executions migration applied');

  db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as Database;
}

// Reset stale agent statuses from previous server runs
// Agents stuck in active states ('starting', 'planning', 'running') cannot be
// legitimately running after a server restart — reset them to 'idle'.
try {
  const staleStatuses = ['starting', 'planning', 'running'] as const;
  const result = await db
    .update(schemaTables.agents)
    .set({
      status: 'idle',
      currentTaskId: null,
      currentSessionId: null,
      updatedAt: new Date().toISOString(),
    })
    .where(inArray(schemaTables.agents.status, [...staleStatuses]));
  const changes = getChangedCount(result);
  if (changes > 0) {
    log.info(`Reset ${changes} stale agent(s) to idle`);
  }
} catch (error) {
  log.error('Failed to reset stale agents', {
    error: error instanceof Error ? error : new Error(String(error)),
  });
}

// Recover orphaned tasks from previous server runs
// Tasks stuck in 'in_progress' with a non-null agentId cannot be legitimately running
// after a restart — move them back to 'backlog' and clear stale references.
// Uses direct DB update (not taskService.moveColumn) to avoid triggering agent auto-start.
try {
  const result = await db
    .update(schemaTables.tasks)
    .set({
      column: 'backlog',
      agentId: null,
      sessionId: null,
      lastAgentStatus: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(schemaTables.tasks.column, 'in_progress'), isNotNull(schemaTables.tasks.agentId))
    );
  const changes = getChangedCount(result);
  if (changes > 0) {
    console.log(`[API Server] Recovered ${changes} orphaned task(s) back to backlog`);
  }
} catch (error) {
  console.error(
    '[API Server] Failed to recover orphaned tasks:',
    error instanceof Error ? error.message : String(error)
  );
}

// Clean up orphaned worktrees from tasks where agents are no longer running (Gap 2)
// After a server crash, tasks may still reference worktrees that should be cleaned up.
try {
  const orphanedTasks = await db
    .select({ id: schemaTables.tasks.id, worktreeId: schemaTables.tasks.worktreeId })
    .from(schemaTables.tasks)
    .where(isNotNull(schemaTables.tasks.worktreeId));

  // Filter to tasks whose agent is not actively running (after restart, none are)
  const tasksToClean = orphanedTasks.filter(
    (t) => t.worktreeId && (t as { lastAgentStatus?: string }).lastAgentStatus !== 'planning'
  );

  if (tasksToClean.length > 0) {
    console.log(`[API Server] Found ${tasksToClean.length} task(s) with orphaned worktrees`);
    for (const t of tasksToClean) {
      try {
        await db
          .update(schemaTables.tasks)
          .set({
            worktreeId: null,
            branch: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schemaTables.tasks.id, t.id));
      } catch (cleanErr) {
        console.error(
          `[API Server] Failed to clear worktree refs for task ${t.id}:`,
          cleanErr instanceof Error ? cleanErr.message : String(cleanErr)
        );
      }
    }
    console.log(`[API Server] Cleared worktree references from ${tasksToClean.length} task(s)`);
    // Note: actual worktree removal happens via WorktreeService after it's initialized below
  }
} catch (error) {
  console.error(
    '[API Server] Failed to clean orphaned worktrees:',
    error instanceof Error ? error.message : String(error)
  );
}

// Initialize services
const githubService = new GitHubTokenService(db);
const apiKeyService = new ApiKeyService(db);
const templateService = new TemplateService(db);
const sandboxConfigService = new SandboxConfigService(db);

// Resolve Anthropic API key from all sources (DB, env vars, credentials file).
// If the key came from the DB and isn't already in env, make it available to
// the Claude Agent SDK subprocess:
//   - Regular API keys (sk-ant-api*): inject into process.env.ANTHROPIC_API_KEY
//   - OAuth tokens (sk-ant-oat*): write to ~/.claude/.credentials.json in the
//     claudeAiOauth format the CLI expects (API rejects OAuth tokens via env var)
{
  const os = await import('node:os');
  const { resolveAnthropicApiKey } = await import('../lib/utils/resolve-anthropic-key.js');
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_OAUTH_TOKEN;
  const resolvedKey = await resolveAnthropicApiKey(apiKeyService);
  const isProduction = process.env.NODE_ENV === 'production';

  if (!resolvedKey) {
    const msg =
      'No Anthropic API key found (checked database, ANTHROPIC_API_KEY env var, and ~/.claude/.credentials.json) — agent execution will fail';
    if (isProduction) {
      log.error(msg);
      process.exit(1);
    }
    log.warn(msg);
  } else if (!hasEnvKey) {
    const isOAuthToken = resolvedKey.startsWith('sk-ant-oat');
    if (isOAuthToken) {
      // OAuth tokens must go through the credentials file — the API rejects
      // them when passed via ANTHROPIC_API_KEY env var. Write in the
      // claudeAiOauth format that the Claude CLI expects.
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      try {
        await fs.mkdir(path.dirname(credPath), { recursive: true });
        await fs.writeFile(
          credPath,
          JSON.stringify(
            {
              claudeAiOauth: {
                accessToken: resolvedKey,
                refreshToken: '',
                expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
                scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                subscriptionType: 'max',
              },
            },
            null,
            2
          ),
          'utf-8'
        );
        log.info('Anthropic OAuth credentials file written', {
          data: { source: 'database', credPath },
        });
      } catch (writeErr) {
        log.warn('Failed to write OAuth credentials file', {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    } else {
      // Regular API key — safe to inject into env for SDK subprocess
      process.env.ANTHROPIC_API_KEY = resolvedKey;
      log.info('Anthropic API key resolved', { data: { source: 'database' } });
    }
  } else {
    const source = process.env.ANTHROPIC_API_KEY ? 'env' : 'env_oauth';
    log.info('Anthropic API key resolved', { data: { source } });
  }
}

// TaskService with stub worktreeService for basic CRUD
const taskService = new TaskService(db, {
  getDiff: async () => ({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented', status: 501 },
  }),
  merge: async () => ({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented', status: 501 },
  }),
  remove: async () => ({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented', status: 501 },
  }),
});

// CaddyDurableStreamsServer - publishes to Caddy (prod) or DurableStreamTestServer (dev)
const streamsServerUrl =
  process.env.CADDY_STREAMS_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'http://localhost:3000/v1/stream'
    : 'http://localhost:3002/v1/stream');
const caddyStreamsServer = new CaddyDurableStreamsServer(streamsServerUrl);
log.info('[API Server] Using CaddyDurableStreamsServer', { data: { url: streamsServerUrl } });

// CLI Monitor service for monitoring Claude Code CLI sessions (with DB persistence)
const cliMonitorService = new CliMonitorService(caddyStreamsServer, db);
log.info('[API Server] CLI Monitor receiver ready (waiting for daemon)');

// DurableStreamsService for SSE and container agent events
// Pass db for event persistence to session_events table
const durableStreamsService = new DurableStreamsService(caddyStreamsServer, db);

// SessionService for session management (needed for task creation history)
const sessionService = new SessionService(db, caddyStreamsServer, {
  baseUrl: 'http://localhost:3001',
});

// TaskCreationService for AI-powered task creation (with session tracking)
const taskCreationService: TaskCreationService = createTaskCreationService(
  db,
  durableStreamsService,
  sessionService
);

// CommandRunner for WorktreeService using Bun.spawn
const bunCommandRunner: CommandRunner = {
  exec: async (command: string, cwd: string) => {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${stderr || stdout}`);
    }

    return { stdout, stderr };
  },
};

// WorktreeService for git worktree operations
const worktreeService = new WorktreeService(db, bunCommandRunner);

// Update TaskService with real worktreeService for getDiff support
taskService.setWorktreeService({
  getDiff: (worktreeId: string) => worktreeService.getDiff(worktreeId),
  merge: (worktreeId: string, targetBranch?: string) =>
    worktreeService.merge(worktreeId, targetBranch),
  remove: (worktreeId: string) => worktreeService.remove(worktreeId),
});

// ============================================================================
// Sandbox Provider Initialization (deferred — runs after server starts)
// ============================================================================
// Selects and initializes the configured sandbox provider (Docker or K8s CRD).
// Initialization runs asynchronously after Bun.serve() so it never blocks startup.
// Routes use getSandboxProvider() getter to access the latest provider reference.

let sandboxProvider: EventEmittingSandboxProvider | null = null;
let containerAgentService: ReturnType<typeof createContainerAgentService> | null = null;

// Module-level reference to the K8s provider for the auto-heal interval
// and for health/status routes. Set inside initSandboxProvider() when K8s is active.
let activeK8sProvider: ReturnType<typeof createAgentSandboxProvider> | null = null;
let sandboxController: SandboxController | null = null;

// Module-level reference to the Nomad provider for health/status routes.
let activeNomadProvider:
  | import('../lib/sandbox/providers/nomad-sandbox-provider.js').NomadSandboxProvider
  | null = null;

/** Getter for routes that need to check K8s provider health. */
function getK8sProvider() {
  return activeK8sProvider;
}

/** Getter for routes that need to check Nomad provider health. */
function getNomadProvider() {
  return activeNomadProvider;
}

// Module-level reference to the AgentCore provider for health/status routes.
let activeAgentCoreProvider:
  | import('../lib/sandbox/providers/agentcore-sandbox-provider.js').AgentCoreSandboxProvider
  | null = null;

/** Getter for routes that need to check AgentCore provider health. */
function getAgentCoreProvider() {
  return activeAgentCoreProvider;
}

/**
 * Poll `kubectl get crd sandboxes.agents.x-k8s.io` every 1s until success
 * or the timeout is reached (default 10s). Returns true when the CRD is registered.
 */
async function waitForCrdRegistration(maxWaitMs = 10_000): Promise<boolean> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await execAsync('kubectl get crd sandboxes.agents.x-k8s.io', { timeout: 5_000 });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return false;
}

/**
 * Create a default K8s sandbox pod if one doesn't already exist.
 * Mirrors Docker's default sandbox creation pattern.
 */
/**
 * Ensure a default sandbox exists for the given provider.
 * Shared between K8s and Nomad providers (identical lifecycle logic).
 */
async function ensureDefaultSandbox(
  provider: {
    get(projectId: string): Promise<{ status: string; stop(): Promise<void> } | null>;
    create(config: SandboxConfig): Promise<unknown>;
  },
  label: string
): Promise<void> {
  try {
    const existingDefault = await provider.get('default');

    if (
      existingDefault &&
      (existingDefault.status === 'error' || existingDefault.status === 'stopped')
    ) {
      log.info(`Default ${label} sandbox in terminal state, recreating`, {
        data: { status: existingDefault.status },
      });
      if (existingDefault.status === 'error') {
        try {
          await existingDefault.stop();
        } catch (stopErr) {
          log.warn(`Failed to stop error-state default ${label} sandbox during recreation`, {
            error: stopErr instanceof Error ? stopErr : new Error(String(stopErr)),
          });
        }
      }
      // Fall through to create
    } else if (existingDefault) {
      return; // Healthy default exists
    }

    const defaults = await loadSandboxDefaultsFromDb();
    await provider.create({
      projectId: 'default',
      projectPath: '/workspace',
      image: defaults?.image ?? SANDBOX_DEFAULTS.image,
      memoryMb: defaults?.memoryMb ?? 2048,
      cpuCores: defaults?.cpuCores ?? 2,
      idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
      volumeMounts: [],
    });
    log.info(`Default ${label} sandbox created`);
  } catch (createErr) {
    log.error(`Failed to create default ${label} sandbox`, {
      error: createErr instanceof Error ? createErr : new Error(String(createErr)),
    });
  }
}

/**
 * Load sandbox defaults from the database settings.
 * Reusable helper for both Docker and K8s default sandbox creation.
 */
async function loadSandboxDefaultsFromDb(): Promise<{
  image?: string;
  memoryMb?: number;
  cpuCores?: number;
  idleTimeoutMinutes?: number;
} | null> {
  try {
    const globalDefaults = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.defaults'),
    });
    if (globalDefaults?.value) {
      return JSON.parse(globalDefaults.value) as {
        image?: string;
        memoryMb?: number;
        cpuCores?: number;
        idleTimeoutMinutes?: number;
      };
    }
  } catch (settingsErr) {
    console.warn(
      '[API Server] Failed to load sandbox settings (using defaults):',
      settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
    );
  }
  return null;
}

/** Clear any stale `sandbox.nomad.lastError` from the settings table. */
async function clearNomadLastError() {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.nomad.lastError'));
  } catch (err) {
    log.debug('Failed to clear stale Nomad error (non-critical)', {
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Persist a Nomad error message to the settings table for UI display. */
async function persistNomadLastError(message: string): Promise<void> {
  try {
    const value = JSON.stringify({
      error: message,
      timestamp: new Date().toISOString(),
    });
    await db
      .insert(schemaTables.settings)
      .values({ key: 'sandbox.nomad.lastError', value })
      .onConflictDoUpdate({
        target: schemaTables.settings.key,
        set: { value },
      });
  } catch (persistErr) {
    log.warn('Failed to persist Nomad error', {
      error: persistErr instanceof Error ? persistErr : new Error(String(persistErr)),
    });
  }
}

/** Clear any stale `sandbox.kubernetes.lastError` from the settings table. */
async function clearK8sLastError() {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.kubernetes.lastError'));
  } catch (_) {
    // ignore — stale error display is non-critical
  }
}

/**
 * Initialize the sandbox provider asynchronously.
 * Called after Bun.serve() so the server is already accepting requests.
 */
async function initSandboxProvider() {
  // Step 1: Determine which provider to use from settings
  type ProviderSelection = 'docker' | 'kubernetes' | 'nomad' | 'agentcore';
  let providerType: ProviderSelection = 'docker'; // default
  let k8sFallbackToDocker = false;
  let nomadFallbackToDocker = false;
  let agentcoreFallbackToDocker = false;

  try {
    const providerSetting = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.defaults'),
    });
    if (providerSetting?.value) {
      const parsed = JSON.parse(providerSetting.value) as {
        provider?: string;
        fallbackToDocker?: boolean;
      };
      if (parsed.provider === 'kubernetes') {
        providerType = 'kubernetes';
      } else if (parsed.provider === 'nomad') {
        providerType = 'nomad';
      } else if (parsed.provider === 'agentcore') {
        providerType = 'agentcore';
      }
      k8sFallbackToDocker = parsed.fallbackToDocker ?? false;
      // Default nomadFallbackToDocker from shared setting; may be overridden below
      nomadFallbackToDocker = parsed.fallbackToDocker ?? false;
      agentcoreFallbackToDocker = parsed.fallbackToDocker ?? false;
    }

    // Check for a separate Nomad-specific fallbackToDocker setting
    if (providerType === 'nomad') {
      try {
        const nomadSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.nomad'),
        });
        if (nomadSetting?.value) {
          const nomadParsed = JSON.parse(nomadSetting.value) as {
            fallbackToDocker?: boolean;
          };
          if (nomadParsed.fallbackToDocker !== undefined) {
            nomadFallbackToDocker = nomadParsed.fallbackToDocker;
          }
        }
      } catch (err) {
        log.warn('Failed to read Nomad fallbackToDocker setting, using shared value', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  } catch (settingsErr) {
    console.warn(
      '[API Server] Failed to load sandbox provider setting (using Docker default):',
      settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
    );
  }

  // Step 2: Initialize the selected provider
  if (providerType === 'kubernetes') {
    // ------ Kubernetes CRD Provider ------
    try {
      // Load K8s-specific settings from the sandbox.kubernetes key
      let k8sSettings: {
        namespace?: string;
        kubeConfigPath?: string;
        kubeContext?: string;
        enableWarmPool?: boolean;
        warmPoolSize?: number;
        runtimeClassName?: 'gvisor' | 'kata' | 'none';
        image?: string;
        skipTLSVerify?: boolean;
        autoStartMinikube?: boolean;
        autoInstallCRDs?: boolean;
      } = { autoInstallCRDs: true };

      try {
        const k8sSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
        });
        if (k8sSetting?.value) {
          const parsed = JSON.parse(k8sSetting.value);
          k8sSettings = {
            ...parsed,
            autoInstallCRDs: parsed.autoInstallCRDs ?? true,
          };
        }
      } catch {
        // Use defaults
      }

      const k8sProvider = createAgentSandboxProvider({
        namespace: k8sSettings.namespace,
        kubeConfigPath: k8sSettings.kubeConfigPath,
        kubeContext: k8sSettings.kubeContext,
        enableWarmPool: k8sSettings.enableWarmPool,
        warmPoolSize: k8sSettings.warmPoolSize,
        runtimeClassName: k8sSettings.runtimeClassName,
        image: k8sSettings.image,
        skipTLSVerify: k8sSettings.skipTLSVerify,
      });

      // Verify cluster connectivity and controller installation
      let health = await k8sProvider.healthCheck();
      if (health.healthy) {
        sandboxProvider = k8sProvider;
        activeK8sProvider = k8sProvider;
        log.info('[API Server] Kubernetes CRD sandbox provider initialized', {
          data: {
            namespace: k8sSettings.namespace ?? 'agentpane-sandboxes',
            controller: health.details?.controller,
          },
        });

        // Clear any stale error from a previous failed initialization
        await clearK8sLastError();

        // Start built-in CRD controller if no external controller detected
        if (!(health.details?.controller as { installed?: boolean })?.installed) {
          sandboxController = new SandboxController(
            k8sProvider.client,
            k8sSettings.namespace ?? 'agentpane-sandboxes'
          );
          await sandboxController.start();
          log.info(
            '[API Server] Built-in sandbox controller started (no external controller detected)'
          );
        }

        // Create default K8s sandbox pod (mirrors Docker default sandbox pattern)
        await ensureDefaultSandbox(k8sProvider, 'K8s');

        // Initialize warm pool if enabled
        if (k8sSettings.enableWarmPool) {
          try {
            await k8sProvider.initWarmPool();
            log.info('[API Server] Warm pool initialized');
          } catch (warmPoolErr) {
            console.warn(
              '[API Server] Warm pool initialization failed (continuing without):',
              warmPoolErr instanceof Error ? warmPoolErr.message : String(warmPoolErr)
            );
          }
        }
      } else {
        // K8s unhealthy — attempt minikube autostart if configured
        const clusterUnreachable =
          !health.details?.clusterVersion && !health.details?.clusterReachable;

        if (
          clusterUnreachable &&
          k8sSettings.autoStartMinikube &&
          isMinikubeContext(k8sSettings.kubeContext)
        ) {
          log.info('[API Server] Kubernetes cluster unreachable, attempting minikube start...');
          const started = await attemptMinikubeStart();
          if (started) {
            log.info('[API Server] Minikube started successfully, retrying health check...');
            health = await k8sProvider.healthCheck();
            if (health.healthy) {
              sandboxProvider = k8sProvider;
              activeK8sProvider = k8sProvider;
              log.info(
                '[API Server] Kubernetes CRD sandbox provider initialized after minikube start',
                {
                  data: { namespace: k8sSettings.namespace ?? 'agentpane-sandboxes' },
                }
              );

              // Clear any stale error from a previous failed initialization
              await clearK8sLastError();

              // Start built-in CRD controller if no external controller detected
              if (!(health.details?.controller as { installed?: boolean })?.installed) {
                sandboxController = new SandboxController(
                  k8sProvider.client,
                  k8sSettings.namespace ?? 'agentpane-sandboxes'
                );
                await sandboxController.start();
                log.info(
                  '[API Server] Built-in sandbox controller started (no external controller detected)'
                );
              }

              // Create default K8s sandbox pod
              await ensureDefaultSandbox(k8sProvider, 'K8s');

              // Initialize warm pool if enabled
              if (k8sSettings.enableWarmPool) {
                try {
                  await k8sProvider.initWarmPool();
                  log.info('[API Server] Warm pool initialized');
                } catch (warmPoolErr) {
                  console.warn(
                    '[API Server] Warm pool initialization failed (continuing without):',
                    warmPoolErr instanceof Error ? warmPoolErr.message : String(warmPoolErr)
                  );
                }
              }
            }
          }
        }

        // Auto-install CRDs if configured and CRDs are missing
        if (!sandboxProvider && k8sSettings.autoInstallCRDs) {
          const details = health.details ?? {};
          const needsCrdInstall =
            details.crdRegistered === false || details.namespaceExists === false;

          if (needsCrdInstall) {
            log.info('[API Server] Auto-installing CRDs (autoInstallCRDs enabled)...');
            try {
              const { exec } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const execAsync = promisify(exec);
              const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

              // Apply CRDs, namespace, and supporting manifests
              const manifests = [
                'crds.yaml',
                'namespace.yaml',
                'runtime-class-gvisor.yaml',
                'limit-range.yaml',
              ];

              for (const manifest of manifests) {
                const filePath = path.join(manifestsDir, manifest);
                try {
                  await execAsync(`kubectl apply -f "${filePath}"`, { timeout: 30_000 });
                  log.info(`[API Server] Applied ${manifest}`);
                } catch (err) {
                  console.warn(
                    `[API Server] Failed to apply ${manifest}:`,
                    err instanceof Error ? err.message : String(err)
                  );
                }
              }

              // Wait for CRD registration before applying custom resources
              const crdReady = await waitForCrdRegistration(10_000);
              if (!crdReady) {
                console.warn(
                  '[API Server] CRD registration timed out after 10s — custom resources may fail'
                );
              }

              // Try to install the external CRD controller
              try {
                await execAsync(
                  'kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml"',
                  { timeout: 60_000 }
                );
                log.info('[API Server] CRD controller installed from release URL');
              } catch (ctrlErr) {
                log.warn(
                  '[API Server] CRD controller install from URL failed (continuing with local CRDs)',
                  { error: ctrlErr instanceof Error ? ctrlErr.message : String(ctrlErr) }
                );
              }

              // Apply custom resources (requires CRDs to be registered)
              for (const manifest of [
                'agentpane-sandbox-template.yaml',
                'agentpane-warm-pool.yaml',
              ]) {
                const filePath = path.join(manifestsDir, manifest);
                try {
                  await execAsync(`kubectl apply -f "${filePath}"`, { timeout: 30_000 });
                  log.info(`[API Server] Applied ${manifest}`);
                } catch (err) {
                  console.warn(
                    `[API Server] Failed to apply ${manifest}:`,
                    err instanceof Error ? err.message : String(err)
                  );
                }
              }

              // Retry health check after installation
              health = await k8sProvider.healthCheck();
              if (health.healthy) {
                sandboxProvider = k8sProvider;
                activeK8sProvider = k8sProvider;
                log.info('[API Server] Kubernetes CRD provider initialized after auto-install');

                // Start built-in CRD controller if no external controller detected
                if (!(health.details?.controller as { installed?: boolean })?.installed) {
                  sandboxController = new SandboxController(
                    k8sProvider.client,
                    k8sSettings.namespace ?? 'agentpane-sandboxes'
                  );
                  await sandboxController.start();
                  log.info(
                    '[API Server] Built-in sandbox controller started (no external controller detected)'
                  );
                }

                // Create default K8s sandbox pod
                await ensureDefaultSandbox(k8sProvider, 'K8s');

                if (k8sSettings.enableWarmPool) {
                  try {
                    await k8sProvider.initWarmPool();
                    log.info('[API Server] Warm pool initialized');
                  } catch (warmPoolErr) {
                    console.warn(
                      '[API Server] Warm pool initialization failed (continuing without):',
                      warmPoolErr instanceof Error ? warmPoolErr.message : String(warmPoolErr)
                    );
                  }
                }
              }
            } catch (installErr) {
              log.warn('[API Server] Auto-install CRDs failed:', {
                error: installErr instanceof Error ? installErr.message : String(installErr),
              });
            }
          }
        }

        // Still unhealthy after potential minikube start
        if (!sandboxProvider) {
          const diagnosis = diagnoseK8sFailure(health);
          if (k8sFallbackToDocker) {
            log.warn(
              `[API Server] Kubernetes CRD provider unhealthy: ${diagnosis}. ` +
                'Falling back to Docker provider (fallbackToDocker enabled).'
            );
          } else {
            log.error(
              `[API Server] Kubernetes CRD provider unhealthy: ${diagnosis}. ` +
                'Docker fallback is disabled. Container agent service will not be available.'
            );
            try {
              await db
                .insert(schemaTables.settings)
                .values({
                  key: 'sandbox.kubernetes.lastError',
                  value: JSON.stringify({ error: diagnosis, timestamp: new Date().toISOString() }),
                })
                .onConflictDoUpdate({
                  target: schemaTables.settings.key,
                  set: {
                    value: JSON.stringify({
                      error: diagnosis,
                      timestamp: new Date().toISOString(),
                    }),
                  },
                });
            } catch (persistErr) {
              console.warn('[API Server] Failed to persist K8s error:', persistErr);
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (k8sFallbackToDocker) {
        log.warn(
          `[API Server] Kubernetes CRD provider init failed: ${message}. Falling back to Docker (fallbackToDocker enabled).`
        );
      } else {
        log.error(
          `[API Server] Kubernetes CRD provider init failed: ${message}. ` +
            'Docker fallback is disabled. Container agent service will not be available.'
        );
        try {
          await db
            .insert(schemaTables.settings)
            .values({
              key: 'sandbox.kubernetes.lastError',
              value: JSON.stringify({ error: message, timestamp: new Date().toISOString() }),
            })
            .onConflictDoUpdate({
              target: schemaTables.settings.key,
              set: {
                value: JSON.stringify({ error: message, timestamp: new Date().toISOString() }),
              },
            });
        } catch (persistErr) {
          console.warn('[API Server] Failed to persist K8s error:', persistErr);
        }
      }
    }
  }

  // Step 2b: Nomad provider initialization
  if (providerType === 'nomad' && !sandboxProvider) {
    try {
      // Load Nomad-specific settings from the sandbox.nomad key
      let nomadSettings: {
        address?: string;
        token?: string;
        namespace?: string;
        region?: string;
        datacenter?: string;
        image?: string;
      } = {};

      try {
        const nomadSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.nomad'),
        });
        if (nomadSetting?.value) {
          nomadSettings = JSON.parse(nomadSetting.value);
          // Decrypt the stored token (encrypted at rest)
          if (nomadSettings.token) {
            try {
              nomadSettings.token = decryptToken(nomadSettings.token);
            } catch (decryptErr) {
              log.error('[API Server] Nomad token decryption failed, token must be re-entered', {
                error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
              });
              nomadSettings.token = undefined;
            }
          }
        }
      } catch (dbErr) {
        log.warn('[API Server] Failed to read Nomad settings from database', {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      if (!nomadSettings.address) {
        log.warn('[API Server] Nomad address not configured, falling back to Docker');
      } else {
        // Defense-in-depth: validate stored address at startup (not just on save)
        const { validateNomadAddress } = await import('./routes/sandbox.js');
        const addrValidation = await validateNomadAddress(nomadSettings.address);
        if (!addrValidation.valid) {
          log.warn(
            `[API Server] Nomad address failed SSRF validation: ${addrValidation.error}. Falling back to Docker.`
          );
          await persistNomadLastError(
            `Stored Nomad address failed security validation: ${addrValidation.error}`
          );
        } else {
          const { createNomadSandboxProvider } = await import(
            '../lib/sandbox/providers/nomad-sandbox-provider.js'
          );
          const nomadProvider = createNomadSandboxProvider({
            address: nomadSettings.address,
            token: nomadSettings.token,
            namespace: nomadSettings.namespace,
            region: nomadSettings.region,
            datacenter: nomadSettings.datacenter,
            image: nomadSettings.image,
          });

          const health = await nomadProvider.healthCheck();
          if (health.healthy) {
            sandboxProvider = nomadProvider;
            activeNomadProvider = nomadProvider;
            log.info('[API Server] Nomad sandbox provider initialized', {
              data: {
                address: nomadSettings.address,
                namespace: nomadSettings.namespace ?? 'default',
              },
            });

            // Clear any stale error
            await clearNomadLastError();

            // Create default Nomad sandbox (mirrors Docker/K8s pattern)
            await ensureDefaultSandbox(nomadProvider, 'Nomad');
          } else {
            const diagnosis = health.message ?? 'Nomad cluster health check failed';
            const willFallback = nomadFallbackToDocker;
            const logFn = willFallback ? log.warn : log.error;
            logFn(
              `[API Server] Nomad provider unhealthy: ${diagnosis}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
            );
            await persistNomadLastError(diagnosis);
          }
        } // end SSRF-validated else block
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const willFallback = nomadFallbackToDocker;
      const { NomadApiError, ConnectionError } = await import('@agentpane/nomad-sandbox-sdk');
      const isInfraError = error instanceof NomadApiError || error instanceof ConnectionError;
      // Use warn only for expected infrastructure failures when a fallback is available.
      // Programming errors and no-fallback degradation warrant error-level visibility.
      const logFn = isInfraError && willFallback ? log.warn : log.error;
      logFn(
        `[API Server] Nomad provider init failed: ${message}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
      );
      await persistNomadLastError(message);
    }
  }

  // Step 2c: AgentCore provider initialization
  if (providerType === 'agentcore' && !sandboxProvider) {
    try {
      let agentcoreSettings: {
        awsAccessKeyId?: string;
        awsSecretAccessKey?: string;
        awsRegion?: string;
        ecrRepositoryUri?: string;
        image?: string;
      } = {};

      try {
        const agentcoreSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.agentcore'),
        });
        if (agentcoreSetting?.value) {
          agentcoreSettings = JSON.parse(agentcoreSetting.value);
          // Decrypt the stored secret key (encrypted at rest)
          if (agentcoreSettings.awsSecretAccessKey) {
            try {
              agentcoreSettings.awsSecretAccessKey = decryptToken(
                agentcoreSettings.awsSecretAccessKey
              );
            } catch (decryptErr) {
              log.error(
                '[API Server] AgentCore secret key decryption failed, key must be re-entered',
                {
                  error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
                }
              );
              agentcoreSettings.awsSecretAccessKey = undefined;
            }
          }
        }
      } catch (dbErr) {
        log.warn('[API Server] Failed to read AgentCore settings from database', {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      if (!agentcoreSettings.awsAccessKeyId || !agentcoreSettings.awsSecretAccessKey) {
        log.info(
          `[API Server] AgentCore credentials not configured.${agentcoreFallbackToDocker ? ' Will fall back to Docker.' : ' No fallback configured.'}`
        );
      } else {
        const { createAgentCoreSandboxProvider } = await import(
          '../lib/sandbox/providers/agentcore-sandbox-provider.js'
        );
        const agentcoreProvider = createAgentCoreSandboxProvider({
          awsAccessKeyId: agentcoreSettings.awsAccessKeyId,
          awsSecretAccessKey: agentcoreSettings.awsSecretAccessKey,
          awsRegion: agentcoreSettings.awsRegion,
          ecrRepositoryUri: agentcoreSettings.ecrRepositoryUri,
          image: agentcoreSettings.image,
        });

        const health = await agentcoreProvider.healthCheck();
        if (health.healthy) {
          sandboxProvider = agentcoreProvider;
          activeAgentCoreProvider = agentcoreProvider;
          log.info('[API Server] AgentCore sandbox provider initialized', {
            data: {
              region: agentcoreSettings.awsRegion ?? 'us-east-1',
            },
          });

          // Clear any stale error
          try {
            await db
              .delete(schemaTables.settings)
              .where(eq(schemaTables.settings.key, 'sandbox.agentcore.lastError'));
          } catch (dbErr) {
            log.warn('[API Server] Failed to clear stale AgentCore error from database', {
              error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            });
          }

          // Create default sandbox (mirrors Docker/K8s/Nomad pattern)
          await ensureDefaultSandbox(agentcoreProvider, 'AgentCore');
        } else {
          const diagnosis = health.message ?? 'AgentCore health check failed';
          const willFallback = agentcoreFallbackToDocker;
          const logFn = willFallback ? log.warn : log.error;
          logFn(
            `[API Server] AgentCore provider unhealthy: ${diagnosis}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
          );
          // Persist error for UI display
          try {
            const errorJson = JSON.stringify({
              error: diagnosis,
              timestamp: new Date().toISOString(),
            });
            await db
              .insert(schemaTables.settings)
              .values({ key: 'sandbox.agentcore.lastError', value: errorJson })
              .onConflictDoUpdate({
                target: schemaTables.settings.key,
                set: { value: errorJson, updatedAt: new Date().toISOString() },
              });
          } catch (dbErr) {
            log.warn('[API Server] Failed to persist unhealthy AgentCore status to database', {
              error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const willFallback = agentcoreFallbackToDocker;
      const logFn = willFallback ? log.warn : log.error;
      logFn(
        `[API Server] AgentCore provider init failed: ${message}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
      );
      // Persist error for UI display
      try {
        const errorJson = JSON.stringify({ error: message, timestamp: new Date().toISOString() });
        await db
          .insert(schemaTables.settings)
          .values({ key: 'sandbox.agentcore.lastError', value: errorJson })
          .onConflictDoUpdate({
            target: schemaTables.settings.key,
            set: { value: errorJson, updatedAt: new Date().toISOString() },
          });
      } catch (dbErr) {
        log.warn('[API Server] Failed to persist AgentCore init error to database', {
          error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
        });
      }
    }
  }

  // Step 3: Fall back to Docker if K8s/Nomad was not initialized (or was not selected)
  // Skip Docker fallback if K8s or Nomad was configured and fallback is explicitly disabled
  if (
    !sandboxProvider &&
    !(providerType === 'kubernetes' && !k8sFallbackToDocker) &&
    !(providerType === 'nomad' && !nomadFallbackToDocker) &&
    !(providerType === 'agentcore' && !agentcoreFallbackToDocker)
  ) {
    try {
      const dockerProvider = createDockerProvider();
      log.info('[API Server] Docker provider initialized');

      // Recover existing containers from previous runs
      const { recovered, removed } = await dockerProvider.recover();
      if (recovered > 0 || removed > 0) {
        console.log(
          `[API Server] Container recovery: ${recovered} recovered, ` + `${removed} stale removed`
        );
      }

      sandboxProvider = dockerProvider;

      // Create default sandbox (Docker-specific behavior, not needed for K8s CRD)
      try {
        const existingDefault = await dockerProvider.get('default');
        if (!existingDefault) {
          const defaults = await loadSandboxDefaultsFromDb();

          const defaultImage = defaults?.image ?? SANDBOX_DEFAULTS.image;
          console.log(`[API Server] Checking for default sandbox image: ${defaultImage}`);

          const imageAvailable = await dockerProvider.isImageAvailable(defaultImage);
          console.log(`[API Server] Image available: ${imageAvailable}`);
          if (imageAvailable) {
            try {
              const defaultWorkspacePath = path.join(
                process.cwd(),
                'data',
                'sandbox-workspaces',
                'default'
              );
              await fs.mkdir(defaultWorkspacePath, { recursive: true });

              await dockerProvider.create({
                projectId: 'default',
                projectPath: defaultWorkspacePath,
                image: defaultImage,
                memoryMb: defaults?.memoryMb ?? 2048,
                cpuCores: defaults?.cpuCores ?? 2,
                idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
                volumeMounts: [],
              });
              log.info('[API Server] Default global sandbox created');
            } catch (createErr) {
              log.warn('[API Server] Failed to create default sandbox', {
                error: createErr,
              });
            }
          } else {
            console.log(
              `[API Server] Default sandbox image '${defaultImage}' not available, ` +
                'skipping default sandbox creation'
            );
          }
        } else {
          log.info('[API Server] Default global sandbox already exists');
        }
      } catch (sandboxErr) {
        console.warn(
          '[API Server] Failed to setup default sandbox (container agent still available):',
          sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr)
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isExpectedError =
        message.includes('ENOENT') ||
        message.includes('connect ECONNREFUSED') ||
        message.includes('permission denied') ||
        message.includes('Cannot connect to Docker');

      if (isExpectedError) {
        log.info('[API Server] Docker not available (expected), container agent service disabled');
      } else {
        log.error(`[API Server] Docker initialization failed with unexpected error: ${message}`);
      }
    }
  }

  // K8s diagnostic helpers
  function isMinikubeContext(kubeContext?: string): boolean {
    return kubeContext === 'minikube';
  }

  async function attemptMinikubeStart(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['minikube', 'start'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const result = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('minikube start timed out after 120s')), 120_000)
        ),
      ]);
      return result === 0;
    } catch (err) {
      console.warn(
        '[API Server] Failed to start minikube:',
        err instanceof Error ? err.message : String(err)
      );
      return false;
    }
  }

  function diagnoseK8sFailure(health: {
    healthy: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }): string {
    const details = health.details ?? {};
    if (!details.clusterVersion && !details.clusterReachable) {
      return 'Kubernetes cluster is not reachable';
    }
    if (details.crdRegistered === false) {
      return 'Agent Sandbox CRD is not registered in the cluster';
    }
    if (details.namespaceExists === false) {
      return `Namespace '${details.namespace ?? 'unknown'}' does not exist`;
    }
    return health.message ?? 'Kubernetes cluster health check failed';
  }

  // Step 4: Create ContainerAgentService with whichever provider was initialized
  if (sandboxProvider) {
    try {
      containerAgentService = createContainerAgentService(
        db,
        sandboxProvider,
        durableStreamsService,
        apiKeyService,
        worktreeService,
        githubService
      );

      taskService.setContainerAgentService(containerAgentService);
      log.info(
        `[API Server] ContainerAgentService wired up to TaskService ` +
          `(provider: ${sandboxProvider.name})`
      );
    } catch (serviceErr) {
      console.error(
        '[API Server] Failed to create ContainerAgentService:',
        serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
      );
    }
  } else {
    log.warn('[API Server] initSandboxProvider completed but no sandbox provider was initialized');
  }
} // end initSandboxProvider

// MarketplaceService for plugin marketplace operations
const marketplaceService = new MarketplaceService(db);

// Terraform services
const terraformRegistryService = new TerraformRegistryService(db);
const settingsServiceForCompose = new SettingsService(db);
const terraformComposeService = new TerraformComposeService(
  terraformRegistryService,
  db,
  settingsServiceForCompose,
  durableStreamsService
);

// AgentService for agent lifecycle management
const agentService = new AgentService(db, worktreeService, taskService, sessionService);

// Event plugin system
const pluginRegistry = new PluginRegistry();
pluginRegistry.register('github', new GitHubEventSourcePlugin());
pluginRegistry.register('cron', new CronEventSourcePlugin());

const eventSourceService = new EventSourceService(db);
const eventSubscriptionService = new EventSubscriptionService(db);
const eventProcessingService = new EventProcessingService(
  db,
  pluginRegistry,
  eventSourceService,
  eventSubscriptionService,
  taskService
);

// Task scheduling service
const schedulerService = new SchedulerService(
  db,
  pluginRegistry,
  eventProcessingService,
  eventSourceService
);

// Create the Hono router with all dependencies
const app = createRouter({
  db,
  githubService,
  apiKeyService,
  templateService,
  sandboxConfigService,
  taskService,
  sessionService,
  taskCreationService,
  worktreeService,
  marketplaceService,
  agentService,
  commandRunner: bunCommandRunner,
  getSandboxProvider: () => sandboxProvider,
  getK8sProvider,
  getNomadProvider,
  getAgentCoreProvider,
  cliMonitorService,
  terraformRegistryService,
  terraformComposeService,
  settingsService: settingsServiceForCompose,
  eventSourceService,
  eventSubscriptionService,
  eventProcessingService,
  schedulerService,
});

// Start server
const PORT = 3001;

Bun.serve({
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // Disable idle timeout to prevent Bun from killing long-lived SSE connections
});

console.log(`[API Server] Running on http://localhost:${PORT}`);

// Periodic K8s CRD health check + auto-heal (60s interval)
let k8sCrdHealInProgress = false;
let k8sHealInterval: ReturnType<typeof setInterval> | null = null;

function startK8sHealInterval() {
  if (k8sHealInterval) return; // already running

  k8sHealInterval = setInterval(async () => {
    const provider = activeK8sProvider;
    if (!provider) return;
    if (k8sCrdHealInProgress) return;

    k8sCrdHealInProgress = true;
    try {
      // Proactive cache validation: evict dead sandboxes from provider cache
      try {
        if ('validateSandboxes' in provider && typeof provider.validateSandboxes === 'function') {
          await provider.validateSandboxes();
        }
      } catch (valErr) {
        log.warn('[K8s Heal] Cache validation failed', {
          error: valErr instanceof Error ? valErr.message : String(valErr),
        });
      }

      // Ensure default sandbox exists and is healthy
      try {
        await ensureDefaultSandbox(provider, 'K8s');
      } catch (defaultErr) {
        log.warn('[K8s Heal] Default sandbox check failed', {
          error: defaultErr instanceof Error ? defaultErr.message : String(defaultErr),
        });
      }

      const health = await provider.healthCheck();
      if (health.healthy) return;

      // Check if autoInstallCRDs is enabled
      let autoInstall = true;
      try {
        const k8sSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
        });
        if (k8sSetting?.value) {
          const parsed = JSON.parse(k8sSetting.value);
          autoInstall = parsed.autoInstallCRDs ?? true;
        }
      } catch {
        // Use default
      }

      if (!autoInstall) return;

      const details = health.details ?? {};
      const needsRepair = details.crdRegistered === false || details.namespaceExists === false;

      if (!needsRepair) return;

      log.info('[K8s Heal] CRD/namespace missing, attempting auto-heal...');

      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

      for (const manifest of [
        'crds.yaml',
        'namespace.yaml',
        'runtime-class-gvisor.yaml',
        'limit-range.yaml',
      ]) {
        try {
          await execAsync(`kubectl apply -f "${path.join(manifestsDir, manifest)}"`, {
            timeout: 30_000,
          });
        } catch {
          // Best effort
        }
      }

      await waitForCrdRegistration(10_000);

      for (const manifest of ['agentpane-sandbox-template.yaml', 'agentpane-warm-pool.yaml']) {
        try {
          await execAsync(`kubectl apply -f "${path.join(manifestsDir, manifest)}"`, {
            timeout: 30_000,
          });
        } catch {
          // Best effort
        }
      }

      const recheck = await provider.healthCheck();
      if (recheck.healthy) {
        log.info('[K8s Heal] Auto-heal succeeded — CRDs restored');
      } else {
        console.warn('[K8s Heal] Auto-heal ran but cluster is still unhealthy');
      }
    } catch (err) {
      console.warn(
        '[K8s Heal] Health check failed:',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      k8sCrdHealInProgress = false;
    }
  }, 60_000);
}

// Periodic Nomad health check + auto-heal (60s interval)
let nomadHealInProgress = false;
let nomadHealInterval: ReturnType<typeof setInterval> | null = null;

function startNomadHealInterval() {
  if (nomadHealInterval) return; // already running

  nomadHealInterval = setInterval(async () => {
    const provider = activeNomadProvider;
    if (!provider) return;
    if (nomadHealInProgress) return;

    nomadHealInProgress = true;
    try {
      // Proactive cache validation: evict dead sandboxes from provider cache
      try {
        await provider.validateSandboxes();
      } catch (valErr) {
        log.warn('[Nomad Heal] Cache validation failed', {
          error: valErr instanceof Error ? valErr.message : String(valErr),
        });
      }

      // Ensure default sandbox exists and is healthy
      try {
        await ensureDefaultSandbox(provider, 'Nomad');
      } catch (defaultErr) {
        log.warn('[Nomad Heal] Default sandbox check failed', {
          error: defaultErr instanceof Error ? defaultErr.message : String(defaultErr),
        });
      }

      const health = await provider.healthCheck();
      if (health.healthy) {
        await clearNomadLastError();
        return;
      }

      log.warn('[Nomad Heal] Cluster unhealthy', {
        data: { message: health.message },
      });
    } catch (err) {
      console.warn(
        '[Nomad Heal] Health check failed:',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      nomadHealInProgress = false;
    }
  }, 60_000);
}

// Initialize sandbox provider in the background (non-blocking)
// Then start K8s/Nomad auto-heal intervals if providers are active.
// If initialization fails (e.g. cluster not running at startup), retry with backoff.
let sandboxRetryCount = 0;
const SANDBOX_MAX_RETRIES = 10;
const SANDBOX_BASE_DELAY_MS = 15_000; // 15 seconds
const SANDBOX_MAX_DELAY_MS = 300_000; // 5 minutes
let sandboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

function onSandboxProviderReady() {
  sandboxRetryCount = 0;
  if (sandboxRetryTimer) {
    clearTimeout(sandboxRetryTimer);
    sandboxRetryTimer = null;
  }
  if (activeK8sProvider) {
    startK8sHealInterval();
    log.info('[API Server] K8s CRD auto-heal interval started (60s)');
  }
  if (activeNomadProvider) {
    startNomadHealInterval();
    log.info('[API Server] Nomad auto-heal interval started (60s)');
  }
}

function scheduleSandboxRetry() {
  if (sandboxRetryCount >= SANDBOX_MAX_RETRIES) {
    log.warn(
      `[API Server] Sandbox provider initialization failed after ${SANDBOX_MAX_RETRIES} retries — giving up. Restart the server to try again.`
    );
    return;
  }

  const delay = Math.min(SANDBOX_BASE_DELAY_MS * 2 ** sandboxRetryCount, SANDBOX_MAX_DELAY_MS);
  sandboxRetryCount++;

  log.info(
    `[API Server] Will retry sandbox provider initialization in ${Math.round(delay / 1000)}s (attempt ${sandboxRetryCount}/${SANDBOX_MAX_RETRIES})`
  );

  sandboxRetryTimer = setTimeout(async () => {
    sandboxRetryTimer = null;
    if (sandboxProvider) return; // Already initialized

    try {
      await initSandboxProvider();
      if (sandboxProvider) {
        log.info('[API Server] Sandbox provider initialized on retry');
        onSandboxProviderReady();
      } else {
        scheduleSandboxRetry();
      }
    } catch (err) {
      log.warn('[API Server] Sandbox provider retry failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleSandboxRetry();
    }
  }, delay);
  sandboxRetryTimer.unref(); // Don't prevent process exit
}

initSandboxProvider()
  .then(() => {
    if (sandboxProvider) {
      onSandboxProviderReady();
    } else {
      scheduleSandboxRetry();
    }
  })
  .catch((err) => {
    log.error('[API Server] Sandbox provider initialization failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    scheduleSandboxRetry();
  });

// Start the template sync scheduler
const stopTemplateSync = startSyncScheduler(db, templateService);
log.info('[API Server] Template sync scheduler started');

// Start the Terraform sync scheduler
const stopTerraformSync = startTerraformSyncScheduler(db, terraformRegistryService);
log.info('[API Server] Terraform sync scheduler started');

// Start the task scheduler
schedulerService.start().catch((err) => {
  log.error('[API Server] Failed to start scheduler', { error: err });
});
log.info('[API Server] Task scheduler started');

// Graceful shutdown: stop accepting requests, clean up services, close DB
let isShuttingDown = false;

async function shutdownServer(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`[API Server] Received ${signal}, shutting down gracefully...`);

  // Force-exit safety net after 30 seconds
  const forceExitTimer = setTimeout(() => {
    log.error('[API Server] Graceful shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  // Stop running agents
  if (containerAgentService) {
    const runningAgents = containerAgentService.getRunningAgents();
    for (const agent of runningAgents) {
      containerAgentService.stopAgent(agent.taskId).catch((stopErr) => {
        log.warn('[API Server] Failed to stop agent during shutdown', {
          data: { taskId: agent.taskId, error: String(stopErr) },
        });
      });
    }
    containerAgentService.dispose();
  }

  // Stop K8s auto-heal interval
  if (k8sHealInterval) {
    clearInterval(k8sHealInterval);
    k8sHealInterval = null;
  }

  // Stop Nomad auto-heal interval
  if (nomadHealInterval) {
    clearInterval(nomadHealInterval);
    nomadHealInterval = null;
  }

  // Stop sandbox provider retry timer
  if (sandboxRetryTimer) {
    clearTimeout(sandboxRetryTimer);
    sandboxRetryTimer = null;
  }

  // Stop sandbox controller
  sandboxController?.stop();

  // Stop schedulers
  stopTemplateSync();
  stopTerraformSync();

  // Stop scheduler
  await schedulerService.stop();

  // Clean up services
  cliMonitorService.destroy();

  // Close database
  if (pgClient) {
    try {
      await pgClient.end();
      log.info('[API Server] Database closed');
    } catch (dbErr) {
      log.warn('[API Server] Failed to close database', { error: dbErr });
    }
  } else if (sqlite) {
    try {
      sqlite.close();
      log.info('[API Server] Database closed');
    } catch (dbErr) {
      log.warn('[API Server] Failed to close database', { error: dbErr });
    }
  }

  log.info('[API Server] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('SIGTERM', () => shutdownServer('SIGTERM'));
