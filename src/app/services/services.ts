import type { AppError, createError } from '@/lib/errors/base';
import { ok, type Result } from '@/lib/utils/result';
import { AgentService } from '@/services/agent.service';
import { CodespaceService } from '@/services/codespace.service';
import { DurableStreamsService } from '@/services/durable-streams.service';
import { GitHubTokenService } from '@/services/github-token.service';
import { createPlanModeService, type PlanModeService } from '@/services/plan-mode.service';
import { SandboxConfigService } from '@/services/sandbox-config.service';
import type { DurableStreamsServer } from '@/services/session.service';
import { SessionService } from '@/services/session.service';
import { SettingsService } from '@/services/settings.service';
import { TaskService } from '@/services/task.service';
import {
  createTaskCreationService,
  type TaskCreationService,
} from '@/services/task-creation.service';
import { TemplateService } from '@/services/template.service';
import { WorktreeService } from '@/services/worktree.service';
import type { Database } from '@/types/database';

/**
 * Application services configuration.
 * Provides access to all business logic services.
 */
export type Services = {
  agentService: AgentService;
  durableStreamsService: DurableStreamsService;
  githubTokenService: GitHubTokenService;
  planModeService: PlanModeService;
  codespaceService: CodespaceService;
  sandboxConfigService: SandboxConfigService;
  settingsService: SettingsService;
  taskCreationService: TaskCreationService;
  taskService: TaskService;
  sessionService: SessionService;
  templateService: TemplateService;
  worktreeService: WorktreeService;
};

export type ServicesResult = Result<Services, ReturnType<typeof createError>>;

/**
 * Create application services.
 * Instantiates all service classes with their dependencies.
 */
export function createServices(context: {
  db: Database;
  streams: DurableStreamsServer;
}): ServicesResult {
  try {
    // Create a minimal command runner for browser/test environments
    const runner = {
      exec: async (command: string, cwd: string) => {
        console.log(`[Services] exec: ${command} in ${cwd}`);
        return { stdout: '', stderr: '' };
      },
    };

    const worktreeService = new WorktreeService(context.db, runner);
    const taskService = new TaskService(context.db, {
      getDiff: (worktreeId: string) => worktreeService.getDiff(worktreeId),
      merge: (worktreeId: string, targetBranch?: string) =>
        worktreeService.merge(worktreeId, targetBranch),
      remove: (worktreeId: string) => worktreeService.remove(worktreeId),
    });

    const sessionService = new SessionService(context.db, context.streams, {
      baseUrl: 'http://localhost:3000',
    });

    const codespaceService = new CodespaceService(
      context.db,
      { prune: (codespaceId: string) => worktreeService.prune(codespaceId) },
      runner
    );

    const agentService = new AgentService(
      context.db,
      {
        create: (input) => worktreeService.create(input),
        remove: (id, force) => worktreeService.remove(id, force),
      },
      { moveColumn: (id, column) => taskService.moveColumn(id, column) },
      sessionService
    );

    const templateService = new TemplateService(context.db);
    const sandboxConfigService = new SandboxConfigService(context.db);
    const githubTokenService = new GitHubTokenService(context.db);
    const settingsService = new SettingsService(context.db);

    // Create durable streams service wrapper
    const durableStreamsService = new DurableStreamsService(context.streams);

    // Create plan mode service (GitHub issue creation is optional)
    const planModeService = createPlanModeService(
      context.db,
      durableStreamsService,
      null, // Issue creator not configured in browser environment
      null, // GitHub config not set by default
      { maxTurns: 20 }
    );

    // Create task creation service for AI-powered task creation (with session tracking)
    const taskCreationService = createTaskCreationService(
      context.db,
      durableStreamsService,
      sessionService,
      settingsService
    );

    console.log('[Services] All services initialized successfully');

    return ok({
      agentService,
      durableStreamsService,
      githubTokenService,
      planModeService,
      codespaceService,
      sandboxConfigService,
      settingsService,
      taskCreationService,
      taskService,
      sessionService,
      templateService,
      worktreeService,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Services] Failed to create services:', message);
    return {
      ok: false,
      error: {
        code: 'SERVICE_INITIALIZATION_FAILED',
        message,
        status: 500,
      } as AppError,
    };
  }
}
