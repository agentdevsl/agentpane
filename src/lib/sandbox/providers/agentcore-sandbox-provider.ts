/**
 * AgentCore Sandbox Provider
 *
 * Manages AWS Bedrock AgentCore runtime lifecycle:
 * - Creates/tracks AgentCoreSandboxInstance per project
 * - Assigns isolated runtimeSessionIds per task for microVM isolation
 * - Verifies AWS credentials via STS health check
 *
 * This provider does NOT implement the full SandboxProvider interface
 * (sandbox-provider.ts) because AgentCore has no exec/shell/tmux capabilities.
 * Instead, it provides a focused API for invoke-and-stream workflows.
 */
import { AgentCoreErrors, isAgentCoreError } from '../../errors/agentcore-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { SandboxHealthCheck, SandboxStatus } from '../types.js';
import {
  type AgentCoreInstanceOptions,
  AgentCoreSandboxInstance,
  type SSEEvent,
} from './agentcore-sandbox-instance.js';

const log = createLogger('AgentCoreSandboxProvider');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCoreProviderConfig {
  /** AWS region for the AgentCore runtime */
  region: string;
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** ARN of the AgentCore runtime */
  runtimeArn: string;
}

export interface AgentCoreRuntimeInfo {
  sandboxId: string;
  projectId: string;
  runtimeArn: string;
  status: SandboxStatus;
  createdAt: string;
  activeSessions: number;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AgentCoreSandboxProvider {
  readonly name = 'agentcore';

  private readonly config: AgentCoreProviderConfig;

  /** Instances keyed by projectId */
  private instances = new Map<string, AgentCoreSandboxInstance>();

  /**
   * Runtime session IDs keyed by taskId.
   * Each task gets a unique runtimeSessionId to ensure microVM isolation
   * on the AgentCore side.
   */
  private taskSessions = new Map<string, string>();

  constructor(config: AgentCoreProviderConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new AgentCoreSandboxInstance for a project.
   *
   * Unlike Docker/K8s providers, this doesn't actually create a container.
   * It creates a local handle that can invoke the AgentCore runtime.
   * The actual microVM is provisioned on-demand by AWS when invoke() is called.
   */
  create(projectId: string, sandboxId: string): AgentCoreSandboxInstance {
    // Check for existing instance
    const existing = this.instances.get(projectId);
    if (existing && existing.status !== 'stopped') {
      log.info('Returning existing AgentCore instance for project', {
        data: { projectId, sandboxId: existing.sandboxId },
      });
      return existing;
    }

    const options: AgentCoreInstanceOptions = {
      runtimeArn: this.config.runtimeArn,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      projectId,
      sandboxId,
    };

    const instance = new AgentCoreSandboxInstance(options);
    this.instances.set(projectId, instance);

    log.info('Created AgentCore instance', {
      data: { projectId, sandboxId, runtimeArn: this.config.runtimeArn },
    });

    return instance;
  }

  /**
   * Get an existing instance for a project.
   */
  get(projectId: string): AgentCoreSandboxInstance | null {
    const instance = this.instances.get(projectId);
    if (!instance || instance.status === 'stopped') {
      return null;
    }
    return instance;
  }

  /**
   * List all managed instances (including stopped ones).
   */
  list(): AgentCoreRuntimeInfo[] {
    const result: AgentCoreRuntimeInfo[] = [];

    for (const instance of this.instances.values()) {
      const activeSessions = this.getSessionsByProject(instance.projectId).length;

      result.push({
        sandboxId: instance.sandboxId,
        projectId: instance.projectId,
        runtimeArn: instance.runtimeArn,
        status: instance.status,
        createdAt: instance.createdAt,
        activeSessions,
      });
    }

    return result;
  }

  /**
   * Clean up all instances and sessions.
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const projectIds = [...this.instances.keys()];

    for (const projectId of projectIds) {
      const instance = this.instances.get(projectId);
      if (instance) {
        try {
          await instance.stop();
          cleaned++;
        } catch (stopErr) {
          log.warn('Failed to stop AgentCore instance during cleanup', {
            data: {
              projectId,
              error: stopErr instanceof Error ? stopErr.message : String(stopErr),
            },
          });
        }
      }
    }

    this.instances.clear();
    this.taskSessions.clear();

    log.info('Cleaned up all AgentCore instances', { data: { cleaned } });
    return cleaned;
  }

  // -------------------------------------------------------------------------
  // Session management (per-task microVM isolation)
  // -------------------------------------------------------------------------

  /**
   * Get or create a runtimeSessionId for a task.
   *
   * Each task gets a unique session ID so that AgentCore provisions an
   * isolated microVM for its execution. Session IDs are formatted as
   * `{projectId}:{taskId}:{timestamp}` for traceability in AWS logs.
   */
  getOrCreateSession(projectId: string, taskId: string): string {
    const existing = this.taskSessions.get(taskId);
    if (existing) {
      return existing;
    }

    const sessionId = `${projectId}:${taskId}:${Date.now()}`;
    this.taskSessions.set(taskId, sessionId);

    log.info('Created AgentCore runtime session', {
      data: { projectId, taskId, runtimeSessionId: sessionId },
    });

    return sessionId;
  }

  /**
   * Get the runtimeSessionId for a task (if it exists).
   */
  getSession(taskId: string): string | null {
    return this.taskSessions.get(taskId) ?? null;
  }

  /**
   * Remove the session for a task (after completion or cancellation).
   */
  removeSession(taskId: string): boolean {
    const existed = this.taskSessions.has(taskId);
    this.taskSessions.delete(taskId);
    if (existed) {
      log.info('Removed AgentCore runtime session', { data: { taskId } });
    }
    return existed;
  }

  /**
   * Get all sessions that belong to a specific project.
   * Returns [taskId, runtimeSessionId] pairs.
   */
  private getSessionsByProject(projectId: string): [string, string][] {
    const result: [string, string][] = [];
    for (const [taskId, sessionId] of this.taskSessions) {
      if (sessionId.startsWith(`${projectId}:`)) {
        result.push([taskId, sessionId]);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------

  /**
   * Verify AWS credentials are valid using STS GetCallerIdentity.
   *
   * Uses the @aws-sdk/client-sts package which is already in the project
   * dependencies (package.json).
   */
  async healthCheck(): Promise<SandboxHealthCheck> {
    try {
      // Dynamic import to avoid loading AWS SDK at module level.
      // Use string variable to prevent TypeScript from resolving the module statically.
      const stsModuleName = '@aws-sdk/client-sts';
      const stsModule = (await import(/* webpackIgnore: true */ stsModuleName)) as {
        STSClient: new (config: {
          region: string;
          credentials: { accessKeyId: string; secretAccessKey: string };
        }) => { send(cmd: unknown): Promise<{ Account?: string; Arn?: string }> };
        GetCallerIdentityCommand: new (input: Record<string, never>) => unknown;
      };
      const { STSClient, GetCallerIdentityCommand } = stsModule;

      const sts = new STSClient({
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });

      const identity = await sts.send(new GetCallerIdentityCommand({}));

      return {
        healthy: true,
        message: undefined,
        details: {
          provider: 'agentcore',
          region: this.config.region,
          runtimeArn: this.config.runtimeArn,
          awsAccount: identity.Account,
          awsArn: identity.Arn,
          activeInstances: this.instances.size,
          activeSessions: this.taskSessions.size,
        },
      };
    } catch (error) {
      // Let programming errors propagate — don't mask bugs as credential issues
      if (
        error instanceof TypeError ||
        error instanceof ReferenceError ||
        error instanceof SyntaxError
      ) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      // Check for specific AWS error types
      const errorName = (error as { name?: string })?.name;
      if (errorName === 'ExpiredTokenException' || errorName === 'ExpiredToken') {
        return {
          healthy: false,
          message: 'AWS credentials have expired',
          details: {
            provider: 'agentcore',
            region: this.config.region,
            errorType: 'expired_credentials',
          },
        };
      }

      if (
        errorName === 'InvalidClientTokenId' ||
        errorName === 'SignatureDoesNotMatch' ||
        errorName === 'UnrecognizedClientException'
      ) {
        return {
          healthy: false,
          message: `AWS credentials invalid: ${message}`,
          details: {
            provider: 'agentcore',
            region: this.config.region,
            errorType: 'invalid_credentials',
          },
        };
      }

      return {
        healthy: false,
        message: `AWS STS health check failed: ${message}`,
        details: {
          provider: 'agentcore',
          region: this.config.region,
          runtimeArn: this.config.runtimeArn,
          errorType: 'sts_error',
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Convenience: invoke + stream in one call
  // -------------------------------------------------------------------------

  /**
   * High-level helper that gets/creates an instance and session, then invokes
   * the runtime and returns the SSE event stream.
   *
   * This is the primary entry point for callers who want to execute a task
   * on AgentCore without managing instance/session lifecycle manually.
   */
  async *invokeForTask(
    projectId: string,
    taskId: string,
    sandboxId: string,
    payload: Record<string, unknown>
  ): AsyncGenerator<SSEEvent> {
    const instance = this.get(projectId) ?? this.create(projectId, sandboxId);
    const runtimeSessionId = this.getOrCreateSession(projectId, taskId);

    try {
      yield* instance.invoke(payload, runtimeSessionId);
    } catch (error) {
      // Re-wrap with context if it's not already an AgentCore error
      if (isAgentCoreError(error)) throw error;
      throw AgentCoreErrors.STREAMING_ERROR(error instanceof Error ? error.message : String(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory function for creating an AgentCoreSandboxProvider.
 * Mirrors the createAgentSandboxProvider / createDockerProvider patterns.
 */
export function createAgentCoreProvider(config: AgentCoreProviderConfig): AgentCoreSandboxProvider {
  return new AgentCoreSandboxProvider(config);
}
