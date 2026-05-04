/**
 * ContainerExecService - Container lifecycle: start, stop, process output.
 *
 * Responsibilities:
 * - Start agent-runner inside Docker/K8s/Nomad containers
 * - Stop agents via sentinel files and process kills
 * - Process stdout/stderr from agent-runner
 * - Handle agent completion and error callbacks
 * - Auto-commit worktree changes on completion
 */

import { eq } from 'drizzle-orm';

import { agents, codespaces, sessions, tasks } from '../../db/schema';
import type { CompleteEventMetrics, ContainerBridge } from '../../lib/agents/container-bridge.js';
import { createContainerBridge } from '../../lib/agents/container-bridge.js';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../../lib/constants/models.js';
import { CONTAINER_WORKSPACE_PATH } from '../../lib/constants/sandbox.js';
import { ALLOW_ALL_TOOLS } from '../../lib/constants/tools.js';
import { getRequestId } from '../../lib/context/request-context.js';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import { resolveGitToken } from '../../lib/sandbox/git-token-resolver.js';
import { GitHubCredentialsInjector } from '../../lib/sandbox/github-credentials-injector.js';
import type { Sandbox } from '../../lib/sandbox/providers/sandbox-provider.js';
import { injectAgents, injectSkills } from '../../lib/sandbox/skill-injector.js';
import { SANDBOX_DEFAULTS } from '../../lib/sandbox/types.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import { getAgentMaxRuntimeMs, getGlobalDefaultModel } from '../settings.service.js';
import { TemplateService } from '../template.service.js';
import type { SandboxStateManager } from './sandbox-state.js';
import {
  assertSharedSandboxAllowed,
  resolveOAuthExpiresAtMs,
  resolveOAuthToken,
  updateAgentStatus,
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from './shared-helpers.js';
import type {
  AgentConfig,
  AgentPhase,
  ContainerAgentDeps,
  RunningAgent,
  StartAgentInput,
  TaskPlanRow,
} from './types.js';
import type { WorktreeInitService } from './worktree-init.service.js';

const log = createLogger('ContainerExecService');

export class ContainerExecService {
  constructor(
    private deps: ContainerAgentDeps,
    private state: SandboxStateManager,
    private worktreeInit: WorktreeInitService,
    private onPlanReady: (
      taskId: string,
      sessionId: string,
      codespaceId: string,
      planData: {
        plan: string;
        turnCount: number;
        sdkSessionId: string;
        allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
      }
    ) => Promise<void>,
    private onAgentCompleteCallback?: () =>
      | ((codespaceId: string, taskId: string) => Promise<void>)
      | undefined
  ) {}

  /**
   * Wait for a sandbox to reach 'running' status with exponential backoff.
   * Publishes status events to keep the UI informed.
   */
  private async waitForSandboxReady(
    codespaceId: string,
    sessionId: string,
    taskId: string,
    maxWaitMs = 30_000
  ): Promise<Sandbox> {
    const start = Date.now();
    let delay = 1000;
    const maxDelay = 5000;

    while (Date.now() - start < maxWaitMs) {
      const sandbox = await this.deps.provider.get(codespaceId);
      if (sandbox && sandbox.status === 'running') {
        return sandbox;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      await this.deps.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'creating_sandbox',
        message: `Waiting for sandbox to become ready... (${elapsed}s)`,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }

    throw new Error(
      `Sandbox for codespace ${codespaceId} did not become ready within ${maxWaitMs}ms`
    );
  }

  /**
   * Build environment variables and create the container bridge for agent execution.
   *
   * arch29-W2-I (F04-07, F06-NEW-05): the OAuth access token is NOT passed via
   * the container env. Credentials live exclusively in `~/.claude/.credentials.json`
   * inside the sandbox, written by `CredentialsInjector.writeFile()` before
   * the exec call. This keeps the token out of `/proc/<pid>/environ`,
   * `printenv`, and any tool capturing the agent-runner's environment for
   * diagnostics. `CLAUDE_OAUTH_EXPIRES_AT` and `CLAUDE_OAUTH_REFRESH_TOKEN`
   * are similarly removed — they live in the credentials file alongside the
   * access token.
   */
  private prepareContainerExec(params: {
    taskId: string;
    sessionId: string;
    codespaceId: string;
    phase: AgentPhase;
    sdkSessionId?: string;
    prompt: string;
    agentConfig: AgentConfig;
    worktreePath: string;
    stopFilePath: string;
  }): { env: Record<string, string>; bridge: ContainerBridge } {
    const {
      taskId,
      sessionId,
      codespaceId,
      phase,
      sdkSessionId,
      prompt,
      agentConfig,
      worktreePath,
      stopFilePath,
    } = params;

    // F10-03: propagate the spawning HTTP request id as the agent-runner's
    // correlation id so structured log lines and emitted events can be joined
    // back to the originating request without timestamp triangulation.
    const correlationId = getRequestId();

    const env: Record<string, string> = {
      AGENT_TASK_ID: taskId,
      AGENT_SESSION_ID: sessionId,
      AGENT_PROMPT: prompt,
      AGENT_MAX_TURNS: String(agentConfig.maxTurns),
      AGENT_MODEL: agentConfig.model,
      ...(agentConfig.allowedTools?.length
        ? { AGENT_ALLOWED_TOOLS: JSON.stringify(agentConfig.allowedTools) }
        : {}),
      AGENT_CWD: worktreePath,
      AGENT_STOP_FILE: stopFilePath,
      AGENT_PHASE: phase,
      ...(sdkSessionId ? { AGENT_SDK_SESSION_ID: sdkSessionId } : {}),
      ...(correlationId ? { CORRELATION_ID: correlationId } : {}),
    };
    log.debug('Env vars prepared', {
      data: {
        ...env,
        AGENT_PROMPT: `[${prompt.length} chars]`,
        AGENT_PHASE: phase,
      },
    });

    log.debug('Creating container bridge', { data: { taskId, sessionId, codespaceId, phase } });
    const bridge = createContainerBridge({
      taskId,
      sessionId,
      codespaceId,
      streams: this.deps.streams,
      onComplete: (status, turnCount, metrics) => {
        log.info('Agent completed via bridge callback', { data: { taskId, status, turnCount } });
        void this.handleAgentComplete(taskId, status, turnCount, metrics);
      },
      onError: (error, turnCount) => {
        log.info('Agent error via bridge callback', { data: { taskId, error, turnCount } });
        void this.handleAgentError(taskId, error, turnCount);
      },
      onPlanReady: (planData) => {
        log.info('Plan ready via bridge callback', {
          data: { taskId, planLength: planData.plan.length, sdkSessionId: planData.sdkSessionId },
        });
        void this.onPlanReady(taskId, sessionId, codespaceId, planData);
      },
    });

    return { env, bridge };
  }

  /**
   * Refresh the in-sandbox credentials file in the SDK-compatible CLI shape
   * (`{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes,
   * subscriptionType } }`) immediately before the agent-runner is exec'd.
   *
   * arch29-W2-I (F04-07, F06-NEW-05): the OAuth access token, refresh token,
   * and expiry MUST NOT be passed via container env vars (visible in
   * `/proc/<pid>/environ`, `printenv`, crash dumps, etc.). They live
   * exclusively in `~/.claude/.credentials.json` inside the sandbox.
   *
   * Uses `sandbox.writeFile` (out-of-band tar upload over the exec channel
   * stdin for K8s/Nomad, `putArchive` for Docker) so the JSON content never
   * appears in argv.
   */
  private async injectCredentialsBeforeExec(
    sandbox: Sandbox,
    oauthToken: string,
    oauthRefreshToken: string | null,
    oauthExpiresAtMs: number | null
  ): Promise<Result<void, SandboxError>> {
    const credentialsPath = `${SANDBOX_DEFAULTS.userHome}/.claude/.credentials.json`;

    // Use a far-future sentinel when the host registry has no expiry; matches
    // the agent-runner's previous fallback (theme-03 F11) so the SDK does not
    // see a stale `expiresAt` and immediately try to refresh.
    const expiresAt = oauthExpiresAtMs ?? 100_000_000_000_000;

    const credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: oauthToken,
        refreshToken: oauthRefreshToken,
        expiresAt,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        subscriptionType: 'max',
      },
    });

    // Ensure the .claude directory exists. mkdir -p is idempotent and the
    // path is fixed (no user-supplied data) so this is safe.
    try {
      await sandbox.exec('mkdir', ['-p', `${SANDBOX_DEFAULTS.userHome}/.claude`]);
    } catch (mkdirErr) {
      return err(
        SandboxErrors.CREDENTIALS_INJECTION_FAILED(
          `Failed to ensure .claude directory: ${
            mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)
          }`
        )
      );
    }

    if (typeof sandbox.writeFile !== 'function') {
      // arch29-W2-I requires `writeFile` parity across Docker/K8s/Nomad. If a
      // provider still lacks it, fail closed rather than fall through to a
      // shell-exec path that puts the token in argv.
      return err(
        SandboxErrors.CREDENTIALS_INJECTION_FAILED(
          'Sandbox provider does not implement writeFile — refusing to inject credentials via shell exec (would leak token via argv).'
        )
      );
    }

    try {
      await sandbox.writeFile(credentialsPath, credentialsJson, 0o600);
    } catch (writeErr) {
      return err(
        SandboxErrors.CREDENTIALS_INJECTION_FAILED(
          `Failed to write credentials via writeFile: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`
        )
      );
    }

    return ok(undefined);
  }

  /**
   * Start an agent for a task inside its codespace's sandbox container.
   */
  async startAgent(input: StartAgentInput): Promise<Result<void, SandboxError>> {
    const {
      codespaceId,
      taskId,
      sessionId,
      prompt,
      model,
      maxTurns,
      phase = 'plan',
      sdkSessionId,
    } = input;

    const { db, provider, streams, apiKeyService } = this.deps;

    log.info('Starting agent', {
      data: {
        taskId,
        codespaceId,
        sessionId,
        model,
        maxTurns,
        phase,
        sdkSessionId: sdkSessionId ? '[set]' : undefined,
      },
    });

    // Parallel fetch: codespace and sandbox lookup at the same time
    const [codespace, initialSandbox] = await Promise.all([
      db.query.codespaces.findFirst({ where: eq(codespaces.id, codespaceId) }),
      provider.get(codespaceId),
    ]);

    if (!codespace) {
      log.info('Codespace not found', { data: { codespaceId } });
      return err(SandboxErrors.PROJECT_NOT_FOUND);
    }

    // F06-NEW-02 / arch29-W1-E: enforce the multi-tenant gate before any
    // sandbox lookup or auto-creation. When MULTI_TENANT=true is set in the
    // environment AND the resolved sandbox.mode is 'shared', refuse to
    // start the agent — shared mode uses a single Anthropic OAuth file
    // that every tenant agent could read. Default behaviour for self-
    // hosted single-team installs is unchanged (MULTI_TENANT defaults to
    // false). Throws a typed AppError on violation; convert to Result.
    try {
      await assertSharedSandboxAllowed(db, codespaceId);
    } catch (gateErr) {
      log.error('Multi-tenant gate rejected agent start', {
        data: {
          codespaceId,
          taskId,
          error: gateErr instanceof Error ? gateErr.message : String(gateErr),
        },
      });
      return err(SandboxErrors.MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX(codespaceId));
    }

    // Use shared sandbox mode by default (fastest path - no per-codespace container creation)
    let sandbox = initialSandbox;

    // Recovery: if sandbox exists but is in terminal state, tear it down and recreate
    if (sandbox && (sandbox.status === 'error' || sandbox.status === 'stopped')) {
      log.info('Sandbox in terminal state, tearing down for recreation', {
        data: { codespaceId, sandboxId: sandbox.id, status: sandbox.status },
      });
      try {
        await sandbox.stop();
      } catch (stopErr) {
        log.info('Failed to stop terminal sandbox (continuing with recreate)', {
          data: { error: stopErr instanceof Error ? stopErr.message : String(stopErr) },
        });
      }
      sandbox = null;
    }

    // Auto-create sandbox if missing (K8s may not have a default yet)
    if (!sandbox) {
      log.info('No sandbox found, attempting auto-create', { data: { codespaceId } });
      try {
        if (this.deps.sandboxService) {
          const createResult = await this.deps.sandboxService.getOrCreateForCodespace(codespaceId);
          if (!createResult.ok) {
            return err(createResult.error);
          }
          sandbox =
            (await provider.getById(createResult.value.id)) ?? (await provider.get(codespaceId));
        } else {
          sandbox = await provider.create({
            codespaceId,
            codespacePath: codespace.path ?? '/workspace',
            image: SANDBOX_DEFAULTS.image,
            memoryMb: SANDBOX_DEFAULTS.memoryMb,
            cpuCores: SANDBOX_DEFAULTS.cpuCores,
            idleTimeoutMinutes: SANDBOX_DEFAULTS.idleTimeoutMinutes,
            volumeMounts: [],
          });
        }
        if (!sandbox) {
          return err(SandboxErrors.CONTAINER_NOT_FOUND);
        }
        log.info('Auto-created sandbox', { data: { codespaceId, sandboxId: sandbox.id } });
      } catch (createErr) {
        log.info('Auto-create sandbox failed', {
          data: {
            codespaceId,
            error: createErr instanceof Error ? createErr.message : String(createErr),
          },
        });
        return err(SandboxErrors.CONTAINER_NOT_FOUND);
      }
    }

    log.info('Sandbox ready', { data: { sandboxId: sandbox.id, status: sandbox.status } });

    if (sandbox.status !== 'running') {
      log.info('Sandbox not yet running, waiting for ready', {
        data: { sandboxId: sandbox.id, status: sandbox.status },
      });
      try {
        sandbox = await this.waitForSandboxReady(codespaceId, sessionId, taskId);
        log.info('Sandbox became ready after waiting', { data: { sandboxId: sandbox.id } });
      } catch (waitErr) {
        log.info('Sandbox did not become ready in time', {
          data: { error: waitErr instanceof Error ? waitErr.message : String(waitErr) },
        });
        return err(SandboxErrors.CONTAINER_NOT_RUNNING);
      }
    }

    // Check if sandbox supports streaming exec
    if (!sandbox.execStream) {
      log.info('Sandbox does not support streaming exec', { data: { sandboxId: sandbox.id } });
      return err(SandboxErrors.STREAMING_EXEC_NOT_SUPPORTED);
    }

    // Fetch task to get title for session
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) {
      log.info('Task not found', { data: { taskId } });
      return err(SandboxErrors.TASK_NOT_FOUND(taskId));
    }

    // Create or reuse agent record for this container agent run
    const agentId = `agent-${taskId}`;
    log.debug('Creating agent record', { data: { agentId, codespaceId, taskId } });
    try {
      await db
        .insert(agents)
        .values({
          id: agentId,
          codespaceId,
          name: 'Container Agent',
          type: 'task',
          status: 'starting',
          currentTaskId: taskId,
          currentSessionId: sessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: agents.id,
          set: {
            status: 'starting',
            currentTaskId: taskId,
            currentSessionId: sessionId,
          },
        });
      log.debug('Agent record created/updated', { data: { agentId } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to create agent record', { data: { agentId, error: errorMessage } });
      return err(SandboxErrors.AGENT_RECORD_FAILED(errorMessage, dbErr));
    }

    // Create database session record
    log.debug('Creating session record', { data: { sessionId, taskId } });
    try {
      await db
        .insert(sessions)
        .values({
          id: sessionId,
          codespaceId,
          taskId,
          agentId,
          title: task.title ?? `Container Agent - ${taskId}`,
          url: `/codespaces/${codespaceId}/sessions/${sessionId}`,
          status: 'active',
          sandboxProvider: provider.name,
          sandboxContainerId: sandbox.containerId ?? null,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            sandboxProvider: provider.name,
            sandboxContainerId: sandbox.containerId ?? null,
            agentId,
          },
        });
      log.debug('Session record created/updated', {
        data: { sessionId, sandboxProvider: provider.name },
      });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to create session record', {
        data: { sessionId, taskId, error: errorMessage },
      });
      return err(SandboxErrors.SESSION_CREATE_FAILED(errorMessage, dbErr));
    }

    // Link agent and session to task
    log.debug('Linking agent and session to task', { data: { taskId, agentId, sessionId } });
    try {
      const [linked] = await db
        .update(tasks)
        .set({ agentId, sessionId })
        .where(eq(tasks.id, taskId))
        .returning({ id: tasks.id });
      softInvariant(!!linked, 'task linking expected 1 row', { taskId, agentId });
      log.debug('Task linked to agent and session', { data: { taskId } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to link task to agent/session', { data: { taskId, error: errorMessage } });
      // Continue anyway - linking is non-critical
    }

    // Create durable stream for real-time events
    log.debug('Creating durable stream', { data: { sessionId } });
    try {
      await streams.createStream(sessionId, { type: 'container-agent', codespaceId, taskId });
      log.debug('Stream created successfully', { data: { sessionId } });
    } catch (streamErr) {
      const errorMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!errorMessage.includes('already exists') && !errorMessage.includes('duplicate')) {
        log.error('Failed to create durable stream', { data: { sessionId, error: errorMessage } });
        return err(SandboxErrors.STREAM_CREATE_FAILED(errorMessage));
      }
      log.debug('Stream already exists, continuing', { data: { sessionId } });
    }

    // Publish initial status event
    try {
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'initializing',
        message: 'Starting...',
      });
      log.debug('Initial status event published', { data: { sessionId } });
    } catch (publishErr) {
      const errorMessage = publishErr instanceof Error ? publishErr.message : String(publishErr);
      log.error('Failed to publish initial status event - aborting agent start', {
        data: { sessionId, error: errorMessage },
      });
      return err(SandboxErrors.STREAM_PUBLISH_FAILED(errorMessage));
    }

    // Stage: Validating
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'validating',
      message: 'Validating configuration...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Validating codespace configuration for "${codespace.name}"...`,
    });
    log.info('Validating codespace configuration', { data: { codespaceId, taskId } });

    // Resolve agent configuration
    const codespaceModel = codespace.config?.model as string | undefined;
    const resolvedModel =
      (model ? getFullModelId(model) : undefined) ??
      (codespaceModel ? getFullModelId(codespaceModel) : undefined) ??
      (await getGlobalDefaultModel(db));
    const agentConfig: AgentConfig = {
      model: resolvedModel ?? getFullModelId(DEFAULT_AGENT_MODEL),
      maxTurns: maxTurns ?? codespace.config?.maxTurns ?? 50,
      // F06-06: `[]` fails closed. Fall back to ALLOW_ALL_TOOLS when no config set.
      allowedTools: codespace.config?.allowedTools ?? ALLOW_ALL_TOOLS,
    };
    log.info('Resolved agent config', {
      data: { model: agentConfig.model, maxTurns: agentConfig.maxTurns },
    });

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Configuration validated: model=${agentConfig.model}, maxTurns=${agentConfig.maxTurns}`,
    });
    log.info('Sandbox validated', {
      data: {
        sandboxId: sandbox.id,
        status: sandbox.status,
        containerId: sandbox.containerId?.slice(0, 12),
      },
    });

    // Create sentinel file path for cancellation
    const stopFilePath = `/tmp/.agent-stop-${taskId}`;

    // Clear any stale stop file from a previous run
    try {
      await sandbox.exec('rm', ['-f', stopFilePath]);
    } catch (cleanupErr) {
      log.debug('Failed to clean stale stop file (best effort)', {
        data: {
          stopFilePath,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
      });
    }

    // Stage: Credentials - get OAuth token
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'credentials',
      message: 'Authenticating...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'Retrieving OAuth credentials...',
    });
    log.info('Retrieving OAuth credentials', { data: { taskId } });

    const oauthToken = await resolveOAuthToken(apiKeyService);
    // theme-03 F11: look up real token expiry alongside the token itself.
    const oauthExpiresAtMs = oauthToken ? await resolveOAuthExpiresAtMs(db) : null;
    // F03-09 (arch29-W2-C): pull the OAuth refresh token from the registry so
    // the SDK can rotate the access token mid-run. Returns null when the key
    // was saved without a refresh token (legacy rows, non-OAuth keys).
    const oauthRefreshToken = oauthToken
      ? await apiKeyService.getDecryptedRefreshToken('anthropic')
      : null;

    if (!oauthToken) {
      log.info('No OAuth token available');
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: 'No OAuth token configured. Please add your Anthropic API key in Settings.',
      });
      return err(SandboxErrors.API_KEY_NOT_CONFIGURED);
    }

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'OAuth credentials retrieved successfully',
    });

    // Verify sandbox exec is ready before injecting skills
    const readyCheck = await sandbox.exec('echo', ['ready']);
    if (readyCheck.exitCode !== 0) {
      // Retry once after a short delay
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const retry = await sandbox.exec('echo', ['ready']);
      if (retry.exitCode !== 0) {
        log.warn('Sandbox exec not ready after retry', { data: { exitCode: retry.exitCode } });
      }
    }

    // Stage: Creating Sandbox
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'creating_sandbox',
      message: 'Preparing sandbox...',
    });
    const containerShort = sandbox.containerId?.slice(0, 12) ?? 'unknown';
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Preparing sandbox container (${containerShort})...`,
    });
    log.info('Preparing sandbox environment', {
      data: { sandboxId: sandbox.id, containerId: containerShort },
    });

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'Sandbox container ready',
    });

    // Stage: Worktree
    const needsRemoteWorkspaceInit = provider.name === 'kubernetes' || provider.name === 'nomad';
    let worktreeId: string | undefined;
    let worktreePath = CONTAINER_WORKSPACE_PATH;

    if (needsRemoteWorkspaceInit) {
      const k8sResult = await this.worktreeInit.initializeRemoteWorkspace({
        sandbox,
        codespace,
        task,
        taskId,
        sessionId,
        phase,
      });
      if (k8sResult) {
        worktreePath = k8sResult.worktreePath;
      }
    } else {
      const resolved = await this.worktreeInit.resolveWorktree({
        phase,
        taskId,
        sessionId,
        codespaceId,
        codespace,
        task,
        agentId,
        sandbox,
      });
      worktreeId = resolved.worktreeId;
      worktreePath = resolved.worktreePath;
    }

    // Stage: Injecting Skills - materialize org/template skills into the
    // worktree's `.claude/` directory.
    //
    // This used to run BEFORE worktree creation against
    // `CONTAINER_WORKSPACE_PATH` (= `/workspace`), which left skills at
    // `/workspace/.claude/skills/<id>/SKILL.md`. The agent's cwd is the
    // worktree (`/workspace/.worktrees/<branch>/`), so when the prompt
    // told it to read `.claude/skills/<id>/SKILL.md` the path resolved
    // INSIDE the worktree where nothing had been written — and the
    // model would log "the skill file referenced doesn't exist" and
    // improvise around the missing workflow. Inject into the worktree
    // path so relative reads from the agent succeed.
    const skillNames = [task.skillName, task.executionSkillName].filter(Boolean);
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'injecting_skills',
      message:
        skillNames.length > 0
          ? `Injecting skills: ${skillNames.join(', ')}...`
          : 'Injecting skills...',
    });

    const templateService = new TemplateService(db);
    let skillMessage = 'No template configuration to inject';

    try {
      const mergedResult = await templateService.getMergedConfig(codespaceId);

      if (mergedResult.ok) {
        const { skills, agents: agentTemplates } = mergedResult.value;
        const messageParts: string[] = [];

        if (skills.length > 0) {
          log.info('Injecting template skills into worktree', {
            data: { codespaceId, skillCount: skills.length, worktreePath },
          });
          const injectionResult = await injectSkills(sandbox, skills, worktreePath);
          if (injectionResult.injected === 0 && injectionResult.errors.length > 0) {
            messageParts.push(
              `WARNING: No skills could be injected (${injectionResult.errors.length} errors)`
            );
          } else {
            messageParts.push(
              `Skills: ${injectionResult.injected} new, ${injectionResult.skipped} already present${injectionResult.errors.length > 0 ? `, ${injectionResult.errors.length} errors` : ''}`
            );
          }
          if (injectionResult.errors.length > 0) {
            log.error('Some skills failed to inject', { data: { errors: injectionResult.errors } });
          }
        }

        if (agentTemplates.length > 0) {
          log.info('Injecting template agents into worktree', {
            data: { codespaceId, agentCount: agentTemplates.length, worktreePath },
          });
          const agentResult = await injectAgents(sandbox, agentTemplates, worktreePath);
          if (agentResult.injected === 0 && agentResult.errors.length > 0) {
            messageParts.push(
              `WARNING: No agents could be injected (${agentResult.errors.length} errors)`
            );
          } else {
            messageParts.push(
              `Agents: ${agentResult.injected} new, ${agentResult.skipped} already present${agentResult.errors.length > 0 ? `, ${agentResult.errors.length} errors` : ''}`
            );
          }
          if (agentResult.errors.length > 0) {
            log.error('Some agents failed to inject', { data: { errors: agentResult.errors } });
          }
        }

        skillMessage =
          messageParts.length > 0
            ? messageParts.join(' | ')
            : 'No template skills or agents to inject';
      } else {
        log.debug('No template config to inject', { data: { codespaceId } });
      }
    } catch (skillErr) {
      const errorMsg = skillErr instanceof Error ? skillErr.message : String(skillErr);
      log.error('Skill injection failed (non-fatal)', {
        data: { codespaceId, error: errorMsg },
      });
      skillMessage = `Skill injection skipped: ${errorMsg}`;
    }

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: skillMessage,
    });

    // Read project-level env vars from settings (e.g., TFE_TOKEN, AWS keys)
    // Configured via Settings → sandbox.env and passed through to the container
    let sandboxEnv: Record<string, string> = {};
    try {
      const { SettingsService } = await import('../settings.service.js');
      const settingsService = new SettingsService(db);
      const envResult = await settingsService.getValue<Record<string, string>>('sandbox.env', {});
      if (envResult && typeof envResult === 'object') {
        sandboxEnv = envResult;
      }
    } catch (envErr) {
      log.warn('Failed to read sandbox.env settings (continuing without)', {
        data: { error: envErr instanceof Error ? envErr.message : String(envErr) },
      });
    }

    // Build env vars and create container bridge.
    // arch29-W2-I (F04-07, F06-NEW-05): no OAuth token / refresh / expiry flow
    // through the env any more — those values live in the credentials file
    // injected below via `injectCredentialsBeforeExec`.
    const { env, bridge } = this.prepareContainerExec({
      taskId,
      sessionId,
      codespaceId,
      phase,
      sdkSessionId,
      prompt,
      agentConfig,
      worktreePath,
      stopFilePath,
    });

    // arch29-W2-I (F04-07, F06-NEW-05): refresh ~/.claude/.credentials.json
    // inside the sandbox immediately before exec. The host already retrieved
    // a fresh `oauthToken` (line ~526). For shared sandboxes the file may
    // belong to a previous tenant; for per-project sandboxes a previous run
    // may have stale rotation data. Either way, write the current token
    // (and refresh token + real expiry when available) via `writeFile` so
    // the credential never appears in argv. F03-09 keeps the refresh token
    // in DB; we surface it through the file, not through env.
    const credentialsRefreshResult = await this.injectCredentialsBeforeExec(
      sandbox,
      oauthToken,
      oauthRefreshToken,
      oauthExpiresAtMs
    );
    if (!credentialsRefreshResult.ok) {
      log.error('Failed to refresh credentials file before agent exec', {
        data: {
          taskId,
          sandboxId: sandbox.id,
          error: credentialsRefreshResult.error.message,
        },
      });
      if (worktreeId) {
        await this.worktreeInit.cleanupWorktree(taskId, worktreeId);
      }
      return err(credentialsRefreshResult.error);
    }

    // Inject GitHub credentials (PAT or App installation token) into the
    // sandbox: file-based via writeFile so the token never appears in argv
    // or env. Failure is non-fatal — agents may still operate on local files
    // even without GitHub auth.
    //
    // Always scrub any pre-existing GitHub credential files first, BEFORE
    // deciding whether to write new ones. In shared/reused sandboxes the
    // previous tenant's ~/.git-credentials and ~/.config/gh/hosts.yml may
    // still be on disk; if the current run has no repo configured or token
    // resolution fails, we must not let the next agent inherit the prior
    // tenant's credentials.
    const githubInjector = new GitHubCredentialsInjector();
    {
      const removeResult = await githubInjector.remove(sandbox);
      if (!removeResult.ok) {
        log.warn('Failed to scrub stale GitHub credentials (continuing)', {
          data: { taskId, sandboxId: sandbox.id, error: removeResult.error.message },
        });
      }
    }

    if (codespace.githubOwner && codespace.githubRepo) {
      try {
        const gitToken = await resolveGitToken(
          {
            githubOwner: codespace.githubOwner,
            githubRepo: codespace.githubRepo,
            githubInstallationId: codespace.githubInstallationId,
            codespaceId,
          },
          { db, githubTokenService: this.deps.githubTokenService }
        );
        if (gitToken) {
          const ghResult = await githubInjector.inject(sandbox, {
            token: gitToken.token,
          });
          if (!ghResult.ok) {
            log.warn(
              'Failed to inject GitHub credentials (continuing — agent will not be able to push/PR)',
              {
                data: { taskId, sandboxId: sandbox.id, error: ghResult.error.message },
              }
            );
            // Best-effort scrub on failure so a partial write does not
            // leave readable token fragments behind.
            await githubInjector.remove(sandbox).catch(() => undefined);
          } else {
            log.info('GitHub credentials injected', {
              data: { taskId, owner: gitToken.owner, repo: gitToken.repo },
            });
          }
        } else {
          log.info('No GitHub token available — sandbox will not have push/PR auth', {
            data: { taskId, codespaceId },
          });
        }
      } catch (ghErr) {
        log.warn('GitHub credential injection threw (continuing)', {
          data: {
            taskId,
            error: ghErr instanceof Error ? ghErr.message : String(ghErr),
          },
        });
        // Same reason — scrub anything we might have written before throwing.
        await githubInjector.remove(sandbox).catch(() => undefined);
      }
    }

    // Merge project-level env vars (sandbox.env setting) into container env.
    // Agent-specific vars (AGENT_*, etc.) are already set in `env` by
    // prepareContainerExec, so they take precedence on conflict.
    if (Object.keys(sandboxEnv).length > 0) {
      let applied = 0;
      for (const [key, value] of Object.entries(sandboxEnv)) {
        if (!(key in env)) {
          // Runtime validation: env var values must be strings.
          // Settings are stored as JSON and getValue<Record<string, string>> is a
          // type assertion, not a runtime guarantee.
          if (typeof value !== 'string') {
            log.warn('Skipping sandbox env var with non-string value', {
              data: { key, valueType: typeof value },
            });
            continue;
          }
          env[key] = value;
          applied++;
        }
      }
      log.info('Sandbox env vars applied', {
        data: { requested: Object.keys(sandboxEnv).length, applied },
      });
    }

    // When a skill is assigned, tell the agent-runner to use acceptEdits mode
    // during planning so the skill workflow can use tools like WebSearch, AskUserQuestion
    if (task.skillId) {
      env.AGENT_HAS_SKILL = 'true';
      env.AGENT_SKILL_ID = task.skillId;
      if (task.skillName) env.AGENT_SKILL_NAME = task.skillName;
    }

    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'executing',
      message: phase === 'plan' ? 'Planning...' : 'Executing...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content:
        phase === 'plan'
          ? `Starting planning phase with ${agentConfig.model}...`
          : `Starting execution phase with ${agentConfig.model}...`,
    });

    try {
      log.info('Executing agent-runner in container', {
        data: { sandboxId: sandbox.id, cmd: 'node /opt/agent-runner/dist/index.js' },
      });

      // TOCTOU guard: re-validate sandbox is still running before exec
      if ('refreshStatus' in sandbox && typeof sandbox.refreshStatus === 'function') {
        await sandbox.refreshStatus();
        if (sandbox.status !== 'running') {
          log.info('Sandbox went away between validation and exec', {
            data: { sandboxId: sandbox.id, status: sandbox.status },
          });
          if (worktreeId) {
            await this.worktreeInit.cleanupWorktree(taskId, worktreeId);
          }
          return err(SandboxErrors.CONTAINER_NOT_RUNNING);
        }
      }

      // arch29-W2-I (F04-07, F06-NEW-05): the OAuth token does NOT flow
      // through env any more. The agent-runner reads
      // `~/.claude/.credentials.json` (refreshed above by
      // `injectCredentialsBeforeExec`) as its only authentication source.
      const execResult = await sandbox.execStream({
        cmd: 'node',
        args: ['/opt/agent-runner/dist/index.js'],
        env: {
          ...env,
          AGENT_PROMPT: prompt,
        },
        cwd: worktreePath,
      });
      log.debug('Agent-runner process started', { data: { sandboxId: sandbox.id } });

      // Track the running agent
      const runningAgent: RunningAgent = {
        taskId,
        sessionId,
        codespaceId,
        sandboxId: sandbox.id,
        bridge,
        execResult,
        stopFilePath,
        startedAt: new Date(),
        stopRequested: false,
        phase,
        worktreeId,
      };

      this.state.setRunningAgent(taskId, runningAgent);

      // Set a maximum runtime timeout to prevent runaway agents
      const maxRuntimeMs = await getAgentMaxRuntimeMs(db);
      runningAgent.timeoutHandle = setTimeout(() => {
        log.info('Agent exceeded max runtime, stopping', { data: { taskId, maxRuntimeMs } });
        void this.stopAgent(taskId);
      }, maxRuntimeMs);
      runningAgent.timeoutHandle.unref();

      log.info('Agent registered as running', {
        data: { taskId, totalRunning: this.state.runningAgentCount },
      });

      // Update agent status to 'running' in database
      try {
        const [agentUpdated] = await db
          .update(agents)
          .set({
            status: phase === 'plan' ? 'planning' : 'running',
          })
          .where(eq(agents.id, agentId))
          .returning({ id: agents.id });
        softInvariant(!!agentUpdated, 'agent status update expected 1 row', { agentId, phase });
        log.debug('Agent status updated to running', { data: { agentId, phase } });
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.info('Failed to update agent status', { data: { agentId, error: errorMessage } });
      }

      // Start processing the stdout stream (async, don't await)
      log.debug('Starting stdout stream processing', { data: { taskId } });
      this.processAgentOutput(runningAgent).catch(async (processErr) => {
        const message = processErr instanceof Error ? processErr.message : String(processErr);
        log.warn('Agent output stream failed - user will not see agent output', {
          data: { taskId, sessionId, error: message },
          error: processErr,
        });
        if (this.state.hasRunningAgent(taskId)) {
          try {
            await streams.publish(sessionId, 'container-agent:error', {
              taskId,
              sessionId,
              error: 'Agent output stream failed unexpectedly.',
              turnCount: 0,
            });
            await this.handleAgentError(taskId, message, 0);
          } catch (notifyErr) {
            log.warn('Failed to notify user of stream failure (best-effort)', {
              data: { taskId },
              error: notifyErr,
            });
          }
        }
      });

      // Await critical status events for persistence
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'running',
        message: 'Running',
      });
      await streams.publish(sessionId, 'container-agent:started', {
        taskId,
        sessionId,
        model: agentConfig.model,
        maxTurns: agentConfig.maxTurns,
        sandboxProvider: provider.name,
        sandboxContainerId: sandbox.containerId ?? null,
      });
      log.info('Agent started', { data: { taskId, sessionId } });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to start agent', { data: { taskId, error: message } });
      if (worktreeId) {
        await this.worktreeInit.cleanupWorktree(taskId, worktreeId);
      }
      return err(SandboxErrors.AGENT_START_FAILED(message));
    }
  }

  /**
   * Stop a running container agent by writing a sentinel file.
   */
  async stopAgent(taskId: string): Promise<Result<void, SandboxError>> {
    log.info('Stopping agent', { data: { taskId } });

    const agent = this.state.getRunningAgent(taskId);
    if (!agent) {
      log.info('Agent not found in running agents', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });
      return err(SandboxErrors.AGENT_NOT_RUNNING(taskId));
    }

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runningFor: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    try {
      log.debug('Getting sandbox to write sentinel file', { data: { sandboxId: agent.sandboxId } });
      const sandbox = await this.deps.provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        log.debug('Writing sentinel file', { data: { stopFilePath: agent.stopFilePath } });
        await sandbox.exec('touch', [agent.stopFilePath]);
      } else {
        log.debug('Sandbox not available for sentinel file', {
          data: { sandboxExists: !!sandbox, status: sandbox?.status },
        });
      }

      agent.stopRequested = true;

      log.debug('Killing exec process', { data: { taskId } });
      try {
        await agent.execResult.kill();
      } catch (killError) {
        const killMessage = killError instanceof Error ? killError.message : String(killError);
        log.debug('Exec kill completed with warning', { data: { taskId, warning: killMessage } });
      }

      if (agent.worktreeId) {
        await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
      }

      await this.deps.streams.publish(agent.sessionId, 'container-agent:cancelled', {
        taskId,
        sessionId: agent.sessionId,
        turnCount: 0,
      });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to stop agent', { data: { taskId, error: message } });
      return err(SandboxErrors.AGENT_STOP_FAILED(message));
    }
  }

  /**
   * Process stdout from the agent-runner process.
   */
  private async processAgentOutput(agent: RunningAgent): Promise<void> {
    log.debug('Starting to process agent output', {
      data: { taskId: agent.taskId, sessionId: agent.sessionId, sandboxId: agent.sandboxId },
    });

    agent.bridge.processStderr(agent.execResult.stderr);

    try {
      log.debug('Processing stdout stream through bridge', { data: { taskId: agent.taskId } });
      await agent.bridge.processStream(agent.execResult.stdout);
      log.debug('Bridge finished processing stream', { data: { taskId: agent.taskId } });

      log.debug('Waiting for process to exit', { data: { taskId: agent.taskId } });
      const { exitCode } = await agent.execResult.wait();
      log.info('Process exited', { data: { taskId: agent.taskId, exitCode } });

      if (this.state.hasRunningAgent(agent.taskId) && !agent.completionHandled) {
        if (agent.stopRequested) {
          log.info('Agent stopped via cancellation request', {
            data: { taskId: agent.taskId, exitCode },
          });
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        const errorMessage =
          exitCode === 0
            ? 'Agent exited without emitting a completion event'
            : `Agent process exited with code ${exitCode}`;

        log.info('Process exit without completion, publishing error', {
          data: { taskId: agent.taskId, exitCode },
        });

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, errorMessage, 0);
      } else if (agent.completionHandled) {
        log.debug(
          'Skipping process-exit error path — completion already handled by bridge callback',
          {
            data: { taskId: agent.taskId, exitCode },
          }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Error processing agent output', {
        data: { taskId: agent.taskId, error: message },
        error,
      });

      if (this.state.hasRunningAgent(agent.taskId) && !agent.completionHandled) {
        if (agent.stopRequested) {
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: message,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, message, 0);
      } else if (agent.completionHandled) {
        log.debug('Skipping catch error path — completion already handled by bridge callback', {
          data: { taskId: agent.taskId, error: message },
        });
      }
    } finally {
      log.debug('Stream processing finished', {
        data: { taskId: agent.taskId, stillRunning: this.state.hasRunningAgent(agent.taskId) },
      });
    }
  }

  /**
   * Handle agent completion.
   */
  async handleAgentComplete(
    taskId: string,
    status: 'completed' | 'turn_limit' | 'cancelled' | 'error',
    turnCount: number,
    metrics?: CompleteEventMetrics
  ): Promise<void> {
    log.info('Agent completion callback triggered', { data: { taskId, status, turnCount } });

    const agent = this.state.getRunningAgent(taskId);
    if (!agent) {
      log.debug('Agent not found in running agents map', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });
      return;
    }

    // Guard: mark completion handled immediately to prevent the process-exit path
    // in processAgentOutput from racing against this callback and publishing a
    // spurious "Agent exited without emitting a completion event" error.
    agent.completionHandled = true;

    const { db, provider, streams, worktreeService } = this.deps;

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    // Auto-commit worktree changes when agent finishes
    if (
      agent.worktreeId &&
      worktreeService &&
      (status === 'completed' || status === 'turn_limit')
    ) {
      try {
        const reason = status === 'completed' ? 'completed' : 'reached turn limit';
        const commitResult = await worktreeService.commit(
          agent.worktreeId,
          `Agent ${reason}: ${agent.taskId}`
        );
        if (commitResult.ok) {
          const sha = commitResult.value;
          log.info('Worktree changes committed', {
            data: { taskId, worktreeId: agent.worktreeId, sha: sha || '(no changes)' },
          });
        } else {
          log.info('Worktree commit returned error', {
            data: { taskId, error: String(commitResult.error) },
          });
          await streams
            .publish(agent.sessionId, 'container-agent:message', {
              taskId,
              sessionId: agent.sessionId,
              role: 'system',
              content: `Failed to commit worktree changes: ${String(commitResult.error)}. Agent work may not be persisted.`,
            })
            .catch((publishErr) =>
              log.warn('Failed to notify commit failure', {
                error: publishErr instanceof Error ? publishErr.message : String(publishErr),
              })
            );
        }
      } catch (commitErr) {
        const errorMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
        log.info('Failed to commit worktree changes', {
          data: { taskId, worktreeId: agent.worktreeId, error: errorMessage },
        });
        await streams
          .publish(agent.sessionId, 'container-agent:message', {
            taskId,
            sessionId: agent.sessionId,
            role: 'system',
            content: `Failed to commit worktree changes: ${errorMessage}. Agent work may not be persisted.`,
          })
          .catch((publishErr) =>
            log.warn('Failed to notify commit failure', {
              error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            })
          );
      }
    }

    // Update task status based on completion (using shared helper)
    await updateTaskOnAgentComplete(
      db,
      taskId,
      status,
      streams,
      agent.sessionId,
      this.deps.skillTrackingService,
      metrics
    );

    // Handle worktree cleanup on cancellation
    if (status === 'cancelled' && agent.worktreeId) {
      await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
    }

    // Update agent status to completed/idle (using shared helper)
    await updateAgentStatus(db, taskId, 'completed');

    // Clean up sentinel file
    try {
      log.debug('Cleaning up sentinel file', {
        data: { taskId, stopFilePath: agent.stopFilePath },
      });
      const sandbox = await provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        await sandbox.exec('rm', ['-f', agent.stopFilePath]);
        log.debug('Sentinel file removed', { data: { taskId } });
      } else {
        log.debug('Sandbox not available for cleanup', {
          data: { taskId, sandboxExists: !!sandbox, status: sandbox?.status },
        });
      }
    } catch (cleanupError) {
      log.debug('Failed to cleanup sentinel file (ignoring)', {
        data: {
          taskId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
      });
    }

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.state.deleteRunningAgent(taskId);
    log.info('Agent completion handling finished', {
      data: { taskId, remainingAgents: this.state.runningAgentCount },
    });

    // Auto-dequeue
    const callback = this.onAgentCompleteCallback?.();
    if (status === 'completed' && callback) {
      callback(agent.codespaceId, taskId).catch((dequeueErr) => {
        log.warn('Failed to auto-dequeue next task', {
          data: { taskId },
          error: dequeueErr,
        });
      });
    }
  }

  /**
   * Handle agent error.
   */
  async handleAgentError(taskId: string, error: string, turnCount: number): Promise<void> {
    log.info('Agent error callback triggered', { data: { taskId, error, turnCount } });

    const agent = this.state.getRunningAgent(taskId);
    const { db, streams } = this.deps;

    if (!agent) {
      log.info('Agent not found in running agents map', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });

      const existingTask = (await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      })) as unknown as TaskPlanRow | undefined;

      if (existingTask?.lastAgentStatus === 'planning' && existingTask.plan) {
        const POST_PLAN_ERROR_PATTERNS = [
          'Operation aborted',
          'session closed',
          'EPIPE',
          'stream ended',
        ];
        const isExpectedPostPlanError = POST_PLAN_ERROR_PATTERNS.some((pattern) =>
          error.includes(pattern)
        );

        if (isExpectedPostPlanError) {
          log.info('Suppressing expected post-plan error', {
            data: { taskId, lastAgentStatus: existingTask.lastAgentStatus, error },
          });
          return;
        }

        log.info('Unexpected error after plan capture', {
          data: {
            taskId,
            error,
            lastAgentStatus: existingTask.lastAgentStatus,
            planLength: existingTask.plan.length,
          },
        });
      }

      // Update orphaned agent and task status (using shared helpers)
      await updateAgentStatus(db, taskId, 'error');
      await updateTaskOnAgentError(db, taskId);
      log.info('DB updated for orphaned agent', { data: { taskId } });
      return;
    }

    // Guard: mark completion handled before any async work so the process-exit
    // path in processAgentOutput doesn't race against this error handler.
    agent.completionHandled = true;

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    // Update task - clear agent refs on error (using shared helper)
    await updateTaskOnAgentError(db, taskId, streams, agent.sessionId);

    // Clean up worktree on error
    if (agent.worktreeId) {
      await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
    }

    // Update agent status to error (using shared helper)
    await updateAgentStatus(db, taskId, 'error');

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.state.deleteRunningAgent(taskId);
    log.info('Agent error handling finished', {
      data: { taskId, remainingAgents: this.state.runningAgentCount },
    });
  }
}
