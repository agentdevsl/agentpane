import { createId } from '@paralleldrive/cuid2';
import { count, eq } from 'drizzle-orm';
import type { NewSandboxInstance, NewSandboxTmuxSession, SandboxInstance } from '../db/schema';
import { codespaces, sandboxInstances, sandboxTmuxSessions } from '../db/schema';
import type { SandboxError } from '../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../lib/errors/sandbox-errors.js';
import type { CredentialsInjector } from '../lib/sandbox/credentials-injector.js';
import { createCredentialsInjector } from '../lib/sandbox/credentials-injector.js';
import type { Sandbox, SandboxProvider } from '../lib/sandbox/providers/sandbox-provider.js';
import type { TmuxManager } from '../lib/sandbox/tmux-manager.js';
import { createTmuxManager, TmuxManager as TmuxMgr } from '../lib/sandbox/tmux-manager.js';
import type {
  CodespaceSandboxConfig,
  SandboxConfig,
  SandboxInfo,
  SandboxMetrics,
  TmuxSession,
} from '../lib/sandbox/types.js';
import { SANDBOX_DEFAULTS } from '../lib/sandbox/types.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { DurableStreamsService } from './durable-streams.service.js';
import type { SandboxConfigService, SandboxQuota } from './sandbox-config.service.js';

/**
 * Idle sandbox check interval (every 5 minutes)
 */
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Maximum consecutive failures before disabling idle checker
 */
const MAX_IDLE_CHECK_FAILURES = 5;

/**
 * SandboxService manages Docker sandbox containers for codespaces
 */
export class SandboxService {
  private tmuxManager: TmuxManager;
  private credentialsInjector: CredentialsInjector;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private idleCheckFailureCount = 0;
  private sandboxConfigService: SandboxConfigService | null;
  private quota: SandboxQuota | null;

  constructor(
    private db: Database,
    private provider: SandboxProvider,
    private streams: DurableStreamsService,
    /**
     * F04-10: Optional `SandboxConfigService` reference. When provided
     * together with a quota, `create()` enforces the quota before
     * provisioning a new sandbox. Optional to preserve compatibility with
     * existing call-sites and tests that construct the service without a
     * tenant ceiling — those continue to allow unbounded creates.
     */
    sandboxConfigService?: SandboxConfigService,
    /**
     * F04-10: Per-deployment quota ceiling. Resolved by callers from env or
     * settings. When omitted, no quota enforcement happens.
     */
    quota?: SandboxQuota
  ) {
    this.tmuxManager = createTmuxManager(provider);
    this.credentialsInjector = createCredentialsInjector();
    this.sandboxConfigService = sandboxConfigService ?? null;
    this.quota = quota ?? null;
  }

  /**
   * Start the idle check timer
   */
  startIdleChecker(): void {
    if (this.idleCheckInterval) {
      return;
    }

    this.idleCheckFailureCount = 0;
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleSandboxes()
        .then(() => {
          // Reset failure count on success
          this.idleCheckFailureCount = 0;
        })
        .catch((_error) => {
          this.idleCheckFailureCount++;

          // Disable checker if too many consecutive failures
          if (this.idleCheckFailureCount >= MAX_IDLE_CHECK_FAILURES) {
            this.stopIdleChecker();
          }
        });
    }, IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the idle check timer
   */
  stopIdleChecker(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Get or create a sandbox for a codespace
   */
  async getOrCreateForCodespace(codespaceId: string): Promise<Result<SandboxInfo, SandboxError>> {
    // Check if sandbox exists and is running
    const existing = await this.getByCodespaceId(codespaceId);
    if (existing.ok && existing.value && existing.value.status === 'running') {
      return ok(existing.value);
    }

    // Get codespace and validate sandbox is enabled
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return err(SandboxErrors.PROJECT_NOT_FOUND);
    }

    const sandboxConfig = codespace.config?.sandbox as CodespaceSandboxConfig | undefined;
    if (!sandboxConfig?.enabled) {
      return err(SandboxErrors.SANDBOX_NOT_ENABLED(codespaceId));
    }

    // Build sandbox configuration
    const config: SandboxConfig = {
      codespaceId,
      codespacePath: codespace.path,
      image: sandboxConfig.image ?? SANDBOX_DEFAULTS.image,
      memoryMb: sandboxConfig.memoryMb ?? SANDBOX_DEFAULTS.memoryMb,
      cpuCores: sandboxConfig.cpuCores ?? SANDBOX_DEFAULTS.cpuCores,
      idleTimeoutMinutes: sandboxConfig.idleTimeoutMinutes ?? SANDBOX_DEFAULTS.idleTimeoutMinutes,
      volumeMounts: sandboxConfig.additionalVolumes ?? [],
    };

    // Create sandbox
    return this.create(config);
  }

  /**
   * Create a new sandbox
   *
   * F04-10: enforces the deployment quota when `sandboxConfigService` and
   * `quota` were supplied to the constructor. The current active count is
   * resolved from the DB (`sandbox_instances` rows with status `running`
   * or `starting`) so a hot-restart that re-attaches running containers
   * does not double-count.
   */
  async create(config: SandboxConfig): Promise<Result<SandboxInfo, SandboxError>> {
    // F04-10: enforce per-deployment quota before provisioning. The check
    // runs first so we don't even allocate a stream / sandbox ID when the
    // request would be rejected.
    if (this.sandboxConfigService && this.quota) {
      const activeSandboxes = await this.countActiveSandboxes();
      const quotaResult = this.sandboxConfigService.assertQuota(this.quota, {
        activeSandboxes,
        cpuCores: config.cpuCores,
        memoryMb: config.memoryMb,
      });
      if (!quotaResult.ok) {
        // SandboxConfigError shape is compatible with SandboxError (both AppError).
        return err(quotaResult.error as SandboxError);
      }
    }

    const sandboxId = createId();

    // Use sandbox:-prefixed stream ID to avoid FK constraint violations.
    // Bare CUIDs (without ':') are treated as session IDs and persisted to
    // session_events, which FK-references sessions.id. Sandbox IDs come from
    // sandboxInstances.id, not sessions.id, so we must prefix with 'sandbox:'.
    const streamId = `sandbox:${sandboxId}`;

    // Create the stream for real-time events
    await this.streams.createStream(streamId, {
      type: 'sandbox',
      codespaceId: config.codespaceId,
      image: config.image,
    });

    // Publish creating event
    await this.streams.publish(streamId, 'sandbox:creating', {
      sandboxId,
      codespaceId: config.codespaceId,
      image: config.image,
    });

    try {
      // Check if image is available
      const imageAvailable = await this.provider.isImageAvailable(config.image);
      if (!imageAvailable) {
        // Pull the image
        await this.provider.pullImage(config.image);
      }

      // Create container — pass our sandboxId so provider uses it as its ID.
      // This ensures one consistent ID across stream, DB, and provider lookups.
      const sandbox = await this.provider.create({ ...config, id: sandboxId });

      // Inject credentials - emit warning event if this fails so user is informed
      const credResult = await this.credentialsInjector.inject(sandbox);
      if (!credResult.ok) {
        // Emit warning event so user is aware credentials are missing
        await this.streams.publish(streamId, 'sandbox:error', {
          sandboxId,
          codespaceId: config.codespaceId,
          error: `Sandbox created but credentials injection failed: ${credResult.error.message}. Claude API/CLI access inside the sandbox may not work.`,
          code: 'CREDENTIALS_INJECTION_WARNING',
        });
      }

      // Store in database — sandbox.id === sandboxId (provider used our ID)
      const dbSandbox: NewSandboxInstance = {
        id: sandbox.id,
        codespaceId: config.codespaceId,
        containerId: sandbox.containerId,
        status: 'running',
        image: config.image,
        memoryMb: config.memoryMb,
        cpuCores: config.cpuCores,
        idleTimeoutMinutes: config.idleTimeoutMinutes,
        volumeMounts: config.volumeMounts,
        env: config.env,
      };

      await this.db.insert(sandboxInstances).values(dbSandbox);

      const info = this.sandboxToInfo(sandbox, config);

      // Publish ready event
      await this.streams.publish(streamId, 'sandbox:ready', {
        sandboxId,
        codespaceId: config.codespaceId,
        containerId: sandbox.containerId,
      });

      return ok(info);
    } catch (error) {
      const message = errorMessage(error);

      // Publish error event
      await this.streams.publish(streamId, 'sandbox:error', {
        sandboxId,
        codespaceId: config.codespaceId,
        error: message,
      });

      if (error && typeof error === 'object' && 'code' in error) {
        return err(error as SandboxError);
      }

      return err(SandboxErrors.CONTAINER_CREATION_FAILED(message));
    }
  }

  /**
   * Get sandbox by codespace ID
   */
  async getByCodespaceId(codespaceId: string): Promise<Result<SandboxInfo | null, SandboxError>> {
    const dbSandbox = await this.db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.codespaceId, codespaceId),
    });

    if (!dbSandbox) {
      return ok(null);
    }

    return ok(this.dbSandboxToInfo(dbSandbox));
  }

  /**
   * Get sandbox by ID
   */
  async getById(sandboxId: string): Promise<Result<SandboxInfo | null, SandboxError>> {
    const dbSandbox = await this.db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.id, sandboxId),
    });

    if (!dbSandbox) {
      return ok(null);
    }

    return ok(this.dbSandboxToInfo(dbSandbox));
  }

  /**
   * Stop a sandbox
   */
  async stop(
    sandboxId: string,
    reason: 'manual' | 'idle_timeout' | 'error' = 'manual'
  ): Promise<Result<void, SandboxError>> {
    const dbSandbox = await this.db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.id, sandboxId),
    });

    if (!dbSandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    // Publish stopping event
    await this.streams.publish(`sandbox:${sandboxId}`, 'sandbox:stopping', {
      sandboxId,
      codespaceId: dbSandbox.codespaceId,
      reason,
    });

    try {
      // Get sandbox from provider
      const sandbox = await this.provider.getById(sandboxId);
      if (sandbox) {
        // Kill all tmux sessions - log if any fail but continue with stop
        const killResult = await this.tmuxManager.killAllSessions(sandboxId);
        if (!killResult.ok) {
          // Best-effort: tmux session cleanup failure is non-critical during sandbox stop
        }

        // Stop container
        await sandbox.stop();
      }

      // Update database
      await this.db
        .update(sandboxInstances)
        .set({
          status: 'stopped',
          stoppedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sandboxInstances.id, sandboxId));

      // Publish stopped event
      await this.streams.publish(`sandbox:${sandboxId}`, 'sandbox:stopped', {
        sandboxId,
        codespaceId: dbSandbox.codespaceId,
      });

      return ok(undefined);
    } catch (error) {
      const message = errorMessage(error);

      // Update database with error
      await this.db
        .update(sandboxInstances)
        .set({
          status: 'error',
          errorMessage: message,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sandboxInstances.id, sandboxId));

      // Publish error event
      await this.streams.publish(`sandbox:${sandboxId}`, 'sandbox:error', {
        sandboxId,
        codespaceId: dbSandbox.codespaceId,
        error: message,
      });

      return err(SandboxErrors.CONTAINER_STOP_FAILED(message));
    }
  }

  /**
   * Create a tmux session for a task
   */
  async createTmuxSessionForTask(
    codespaceId: string,
    taskId: string
  ): Promise<Result<TmuxSession, SandboxError>> {
    const sandboxResult = await this.getByCodespaceId(codespaceId);
    if (!sandboxResult.ok) {
      return sandboxResult;
    }

    if (!sandboxResult.value) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    const sessionName = TmuxMgr.createSessionName(taskId);

    const result = await this.tmuxManager.createSession({
      sandboxId: sandboxResult.value.id,
      taskId,
      sessionName,
      workingDirectory: '/workspace',
    });

    if (!result.ok) {
      return result;
    }

    // Store in database
    const dbSession: NewSandboxTmuxSession = {
      sandboxId: sandboxResult.value.id,
      sessionName,
      taskId,
    };

    await this.db.insert(sandboxTmuxSessions).values(dbSession);

    // Publish event
    await this.streams.publish(`sandbox:${sandboxResult.value.id}`, 'sandbox:tmux:created', {
      sandboxId: sandboxResult.value.id,
      sessionName,
      taskId,
    });

    return result;
  }

  /**
   * Get metrics for a sandbox
   */
  async getMetrics(sandboxId: string): Promise<Result<SandboxMetrics, SandboxError>> {
    const sandbox = await this.provider.getById(sandboxId);
    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    try {
      const metrics = await sandbox.getMetrics();
      return ok(metrics);
    } catch (error) {
      const message = errorMessage(error);
      return err(SandboxErrors.INTERNAL_ERROR(message));
    }
  }

  /**
   * Execute a command in a sandbox
   */
  async exec(
    sandboxId: string,
    command: string,
    args: string[] = []
  ): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, SandboxError>> {
    const sandbox = await this.provider.getById(sandboxId);
    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    if (sandbox.status !== 'running') {
      return err(SandboxErrors.CONTAINER_NOT_RUNNING);
    }

    try {
      const result = await sandbox.exec(command, args);
      return ok(result);
    } catch (error) {
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED(command, message));
    }
  }

  /**
   * Refresh credentials in a sandbox
   */
  async refreshCredentials(sandboxId: string): Promise<Result<void, SandboxError>> {
    const sandbox = await this.provider.getById(sandboxId);
    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    return this.credentialsInjector.refresh(sandbox);
  }

  /**
   * Check if a sandbox supports streaming exec (for container agent execution).
   */
  async supportsStreamingExec(sandboxId: string): Promise<boolean> {
    const sandbox = await this.provider.getById(sandboxId);
    return !!sandbox?.execStream;
  }

  /**
   * Get the underlying provider for advanced operations (like container agent service).
   */
  getProvider(): SandboxProvider {
    return this.provider;
  }

  /**
   * Check for idle sandboxes and stop them
   */
  /**
   * SL-015: Per-sandbox error boundaries -- one sandbox failure does not prevent checking others.
   */
  private async checkIdleSandboxes(): Promise<void> {
    const runningSandboxes = await this.db.query.sandboxInstances.findMany({
      where: eq(sandboxInstances.status, 'running'),
    });

    const now = Date.now();

    for (const dbSandbox of runningSandboxes) {
      try {
        const lastActivity = new Date(dbSandbox.lastActivityAt).getTime();
        const idleMs = now - lastActivity;
        const timeoutMs = dbSandbox.idleTimeoutMinutes * 60 * 1000;

        if (idleMs >= timeoutMs) {
          // Publish idle event
          await this.streams.publish(`sandbox:${dbSandbox.id}`, 'sandbox:idle', {
            sandboxId: dbSandbox.id,
            codespaceId: dbSandbox.codespaceId,
            idleSince: lastActivity,
            timeoutMinutes: dbSandbox.idleTimeoutMinutes,
          });

          // Stop the sandbox
          await this.stop(dbSandbox.id, 'idle_timeout');
        }
      } catch (_sandboxErr) {
        // Continue checking remaining sandboxes
      }
    }
  }

  /**
   * Provider health check
   */
  async healthCheck(): Promise<Result<{ healthy: boolean; message?: string }, SandboxError>> {
    const health = await this.provider.healthCheck();

    if (!health.healthy) {
      return err(
        SandboxErrors.PROVIDER_HEALTH_CHECK_FAILED(this.provider.name, health.message ?? 'Unknown')
      );
    }

    return ok(health);
  }

  /**
   * F04-10: Count active sandboxes for quota enforcement. "Active" means
   * `status = 'running'` (a `starting` row would also be in flight, but
   * the schema currently uses `'creating' | 'running' | 'stopped' | 'error'`).
   * Reads from the DB so multi-process deployments share the same picture.
   */
  private async countActiveSandboxes(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(sandboxInstances)
      .where(eq(sandboxInstances.status, 'running'));
    return rows[0]?.n ?? 0;
  }

  /**
   * Convert Sandbox to SandboxInfo
   */
  private sandboxToInfo(sandbox: Sandbox, config: SandboxConfig): SandboxInfo {
    return {
      id: sandbox.id,
      codespaceId: sandbox.codespaceId,
      containerId: sandbox.containerId,
      status: sandbox.status,
      image: config.image,
      createdAt: new Date().toISOString(),
      lastActivityAt: sandbox.getLastActivity().toISOString(),
      memoryMb: config.memoryMb,
      cpuCores: config.cpuCores,
    };
  }

  /**
   * Convert database sandbox to SandboxInfo
   */
  private dbSandboxToInfo(dbSandbox: SandboxInstance): SandboxInfo {
    return {
      id: dbSandbox.id,
      codespaceId: dbSandbox.codespaceId,
      containerId: dbSandbox.containerId,
      status: dbSandbox.status,
      image: dbSandbox.image,
      createdAt: dbSandbox.createdAt,
      lastActivityAt: dbSandbox.lastActivityAt,
      memoryMb: dbSandbox.memoryMb,
      cpuCores: dbSandbox.cpuCores,
    };
  }
}

/**
 * Create a SandboxService
 *
 * F04-10: optional `sandboxConfigService` + `quota` enable per-deployment
 * quota enforcement. Pass them at boot to enforce a ceiling; omit them
 * (default) to preserve unbounded behaviour for tests and self-hosted use.
 */
export function createSandboxService(
  db: Database,
  provider: SandboxProvider,
  streams: DurableStreamsService,
  sandboxConfigService?: SandboxConfigService,
  quota?: SandboxQuota
): SandboxService {
  return new SandboxService(db, provider, streams, sandboxConfigService, quota);
}
