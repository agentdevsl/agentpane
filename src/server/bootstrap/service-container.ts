/**
 * Service Container Factory (CB-004)
 *
 * Constructs all services in correct dependency order.
 * Eliminates the TaskService stub-then-patch pattern by creating
 * WorktreeService first, then passing it directly to TaskService.
 */

import { PluginRegistry } from '../../lib/events/plugin-registry.js';
import { CronEventSourcePlugin } from '../../lib/events/plugins/cron-plugin.js';
import { GitHubEventSourcePlugin } from '../../lib/events/plugins/github.js';
import { createLogger } from '../../lib/logging/logger.js';
import { CaddyDurableStreamsServer } from '../../lib/streams/caddy-producer.js';
import { AgentService } from '../../services/agent.service.js';
import { ApiKeyService } from '../../services/api-key.service.js';
import { CliMonitorService } from '../../services/cli-monitor/index.js';
import { CodespaceService } from '../../services/codespace.service.js';
import { DurableStreamsService } from '../../services/durable-streams.service.js';
import { EventProcessingService } from '../../services/event-processing.service.js';
import { EventSourceService } from '../../services/event-source.service.js';
import { EventSubscriptionService } from '../../services/event-subscription.service.js';
import { GitService } from '../../services/git.service.js';
import { GitHubAppService } from '../../services/github-app.service.js';
import { GitHubTokenService } from '../../services/github-token.service.js';
import { MarketplaceService } from '../../services/marketplace.service.js';
import { DreamService } from '../../services/memory/dream.service.js';
import { MemoryService } from '../../services/memory/index.js';
import type { MemoryStoreService } from '../../services/memory/memory-store.service.js';
import { SkillTrackingService } from '../../services/memory/skill-tracking.service.js';
import { ProjectFolderService } from '../../services/project-folder.service.js';
import { SandboxConfigService } from '../../services/sandbox-config.service.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { SessionService } from '../../services/session.service.js';
import { SettingsService } from '../../services/settings.service.js';
import { TaskService } from '../../services/task.service.js';
import { createTaskCreationService } from '../../services/task-creation.service.js';
import { TemplateService } from '../../services/template.service.js';
import { TerraformComposeService } from '../../services/terraform-compose.service.js';
import { TerraformRegistryService } from '../../services/terraform-registry.service.js';
import { WorkflowService } from '../../services/workflow.service.js';
import { type CommandRunner, WorktreeService } from '../../services/worktree.service.js';
import type { Database } from '../../types/database.js';
import type { ServerConfig, ServiceContainer } from './types.js';

declare const Bun: {
  spawn: (
    cmd: string[],
    options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' }
  ) => {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
};

const log = createLogger('ServiceContainer');

/**
 * Create the Bun-based CommandRunner for shell operations.
 *
 * F06-02 surfaces two entry points:
 *   - `exec(command, cwd)` — legacy `sh -c` path for callers that need
 *     pipes or shell features (git-service reads from pipes, init scripts
 *     are user-authored shell). Callers on this path MUST pre-validate any
 *     user-supplied values they interpolate; see `validateShellCommand`.
 *   - `execArgs(argv, cwd)` — safe positional-argv path. `Bun.spawn(argv)`
 *     passes arguments literally so shell metacharacters cannot be
 *     interpreted. New callers with untrusted input should prefer this.
 */
function createBunCommandRunner(): CommandRunner {
  return {
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
    execArgs: async (argv: string[], cwd: string) => {
      // Positional-argv form (F06-02). No shell is invoked: `Bun.spawn(argv)`
      // passes arguments literally, so metacharacters in user-controlled
      // values cannot be interpreted by sh.
      if (argv.length === 0) {
        throw new Error('argv must contain at least one element');
      }

      const proc = Bun.spawn(argv, {
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
}

/**
 * Create all services in correct dependency order.
 *
 * Dependency graph (simplified):
 * 1. Standalone: GitHubTokenService, ApiKeyService, TemplateService, SandboxConfigService
 * 2. Streams: CaddyDurableStreamsServer -> CliMonitorService, DurableStreamsService
 * 3. Sessions: SessionService (needs CaddyDurableStreamsServer)
 * 4. Tasks: WorktreeService -> TaskService (gets real worktree from start)
 * 5. Task Creation: TaskCreationService (needs DurableStreamsService, SessionService)
 * 6. Agents: AgentService (needs WorktreeService, TaskService, SessionService)
 * 7. Events: PluginRegistry -> EventSourceService -> EventProcessingService -> SchedulerService
 * 8. Terraform: TerraformRegistryService, TerraformComposeService
 */
export function createServiceContainer(db: Database, config: ServerConfig): ServiceContainer {
  const commandRunner = createBunCommandRunner();

  // 1. Standalone services
  const githubService = new GitHubTokenService(db);
  const apiKeyService = new ApiKeyService(db);
  const templateService = new TemplateService(db);
  const sandboxConfigService = new SandboxConfigService(db);
  const settingsService = new SettingsService(db);
  const marketplaceService = new MarketplaceService(db);

  // 2. Streams infrastructure
  const caddyStreamsServer = new CaddyDurableStreamsServer(config.caddyStreamsUrl);
  log.info('Using CaddyDurableStreamsServer', { data: { url: config.caddyStreamsUrl } });

  const cliMonitorService = new CliMonitorService(caddyStreamsServer, db);
  log.info('CLI Monitor receiver ready (waiting for daemon)');

  const durableStreamsService = new DurableStreamsService(caddyStreamsServer, db);

  // 3. Session service
  const sessionService = new SessionService(db, caddyStreamsServer, {
    baseUrl: `http://localhost:${config.port}`,
  });

  // 4. Worktree and Task services (CB-004: proper dependency ordering)
  const worktreeService = new WorktreeService(db, commandRunner);

  // Create TaskService with real worktree methods from the start
  const taskService = new TaskService(db, {
    getDiff: (worktreeId: string) => worktreeService.getDiff(worktreeId),
    merge: (worktreeId: string, targetBranch?: string) =>
      worktreeService.merge(worktreeId, targetBranch),
    remove: (worktreeId: string) => worktreeService.remove(worktreeId),
  });

  // 5. Task creation service
  const taskCreationService = createTaskCreationService(db, durableStreamsService, sessionService);

  // 5.5. Memory service (internal DB-backed, no external Honcho dependency)
  const memoryService = new MemoryService(settingsService, db);

  // 5.6. Skill tracking and dreaming services
  // Reuse the store created inside MemoryService to avoid duplicate instances
  const skillTrackingService = new SkillTrackingService(db);
  const dreamService = new DreamService(
    db,
    settingsService,
    skillTrackingService,
    memoryService.getStore() as MemoryStoreService
  );

  // 6. Agent service
  const agentService = new AgentService(
    db,
    worktreeService,
    taskService,
    sessionService,
    memoryService,
    skillTrackingService
  );

  // Wire agent execution service into task service for host-mode plan approval (AE-002)
  taskService.setAgentExecutionService(agentService);

  // 7. Workflow service
  const workflowService = new WorkflowService(db);

  // 8. Git, Codespace, and ProjectFolder services
  const gitService = new GitService(db, commandRunner);
  const codespaceService = new CodespaceService(db, worktreeService, commandRunner);
  const projectFolderService = new ProjectFolderService(db);

  // 9. GitHub App service
  const githubAppService = new GitHubAppService(db, settingsService);

  // 10. Event system
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

  // 10. Scheduler service
  const schedulerService = new SchedulerService(
    db,
    pluginRegistry,
    eventProcessingService,
    eventSourceService
  );

  // 11. Terraform services
  const terraformRegistryService = new TerraformRegistryService(db);
  const terraformComposeService = new TerraformComposeService(
    terraformRegistryService,
    db,
    settingsService,
    durableStreamsService
  );

  return {
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
    workflowService,
    gitService,
    codespaceService,
    projectFolderService,
    cliMonitorService,
    durableStreamsService,
    terraformRegistryService,
    terraformComposeService,
    settingsService,
    githubAppService,
    eventSourceService,
    eventSubscriptionService,
    eventProcessingService,
    schedulerService,
    commandRunner,
    containerAgentService: null,
    memoryService,
    skillTrackingService,
    dreamService,
  };
}
