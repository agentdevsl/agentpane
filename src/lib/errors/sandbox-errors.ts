import type { AppError } from './base.js';
import { createError } from './base.js';

export type SandboxError = AppError;

export const SandboxErrors = {
  // Container errors
  CONTAINER_NOT_FOUND: createError(
    'SANDBOX_CONTAINER_NOT_FOUND',
    'Sandbox container not found',
    404
  ),

  CONTAINER_ALREADY_EXISTS: (codespaceId: string) =>
    createError(
      'SANDBOX_CONTAINER_ALREADY_EXISTS',
      'Sandbox container already exists for codespace',
      409,
      {
        codespaceId,
      }
    ),

  CONTAINER_CREATION_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_CONTAINER_CREATION_FAILED',
      `Failed to create container: ${message}`,
      500,
      undefined,
      cause
    ),

  CONTAINER_START_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_CONTAINER_START_FAILED',
      `Failed to start container: ${message}`,
      500,
      undefined,
      cause
    ),

  CONTAINER_STOP_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_CONTAINER_STOP_FAILED',
      `Failed to stop container: ${message}`,
      500,
      undefined,
      cause
    ),

  CONTAINER_NOT_RUNNING: createError(
    'SANDBOX_CONTAINER_NOT_RUNNING',
    'Container is not running',
    400
  ),

  // Image errors
  IMAGE_NOT_FOUND: (image: string) =>
    createError('SANDBOX_IMAGE_NOT_FOUND', `Docker image not found: ${image}`, 404, { image }),

  IMAGE_PULL_FAILED: (image: string, message: string) =>
    createError('SANDBOX_IMAGE_PULL_FAILED', `Failed to pull image ${image}: ${message}`, 500, {
      image,
    }),

  // Execution errors
  EXEC_FAILED: (command: string, message: string, cause?: unknown) =>
    createError(
      'SANDBOX_EXEC_FAILED',
      `Command execution failed: ${message}`,
      500,
      { command },
      cause
    ),

  EXEC_TIMEOUT: (command: string, timeoutMs: number) =>
    createError('SANDBOX_EXEC_TIMEOUT', `Command timed out after ${timeoutMs}ms`, 408, {
      command,
      timeoutMs,
    }),

  // tmux errors
  TMUX_SESSION_NOT_FOUND: (sessionName: string) =>
    createError('SANDBOX_TMUX_SESSION_NOT_FOUND', `tmux session not found: ${sessionName}`, 404, {
      sessionName,
    }),

  TMUX_SESSION_ALREADY_EXISTS: (sessionName: string) =>
    createError('SANDBOX_TMUX_SESSION_EXISTS', `tmux session already exists: ${sessionName}`, 409, {
      sessionName,
    }),

  TMUX_CREATION_FAILED: (sessionName: string, message: string) =>
    createError('SANDBOX_TMUX_CREATION_FAILED', `Failed to create tmux session: ${message}`, 500, {
      sessionName,
    }),

  // Credentials errors
  CREDENTIALS_INJECTION_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_CREDENTIALS_INJECTION_FAILED',
      `Failed to inject credentials: ${message}`,
      500,
      undefined,
      cause
    ),

  CREDENTIALS_NOT_FOUND: createError(
    'SANDBOX_CREDENTIALS_NOT_FOUND',
    'OAuth credentials not found',
    401
  ),

  // Provider errors
  PROVIDER_NOT_AVAILABLE: (provider: string) =>
    createError(
      'SANDBOX_PROVIDER_NOT_AVAILABLE',
      `Sandbox provider not available: ${provider}`,
      503,
      {
        provider,
      }
    ),

  PROVIDER_HEALTH_CHECK_FAILED: (provider: string, message: string) =>
    createError(
      'SANDBOX_PROVIDER_HEALTH_CHECK_FAILED',
      `Provider health check failed: ${message}`,
      503,
      { provider }
    ),

  DOCKER_NOT_RUNNING: createError(
    'SANDBOX_DOCKER_NOT_RUNNING',
    'Docker daemon is not running',
    503
  ),

  // Project errors
  PROJECT_NOT_FOUND: createError('SANDBOX_PROJECT_NOT_FOUND', 'Project not found', 404),

  SANDBOX_NOT_ENABLED: (codespaceId: string) =>
    createError('SANDBOX_NOT_ENABLED', 'Sandbox is not enabled for this codespace', 400, {
      codespaceId,
    }),

  // State errors
  INVALID_STATE_TRANSITION: (from: string, to: string) =>
    createError(
      'SANDBOX_INVALID_STATE_TRANSITION',
      `Invalid state transition from ${from} to ${to}`,
      400,
      { from, to }
    ),

  SANDBOX_BUSY: (sandboxId: string) =>
    createError('SANDBOX_BUSY', 'Sandbox is busy with another operation', 409, { sandboxId }),

  // Resource errors
  RESOURCE_LIMIT_EXCEEDED: (resource: string, limit: number, requested: number) =>
    createError(
      'SANDBOX_RESOURCE_LIMIT_EXCEEDED',
      `Resource limit exceeded for ${resource}: requested ${requested}, limit ${limit}`,
      400,
      { resource, limit, requested }
    ),

  // Volume errors
  VOLUME_MOUNT_FAILED: (hostPath: string, containerPath: string, message: string) =>
    createError('SANDBOX_VOLUME_MOUNT_FAILED', `Failed to mount volume: ${message}`, 500, {
      hostPath,
      containerPath,
    }),

  // Generic errors
  INTERNAL_ERROR: (message: string) => createError('SANDBOX_INTERNAL_ERROR', message, 500),

  // Task errors
  TASK_NOT_FOUND: (taskId: string) =>
    createError('SANDBOX_TASK_NOT_FOUND', `Task not found: ${taskId}`, 404, { taskId }),

  // Container agent errors
  AGENT_ALREADY_RUNNING: (taskId: string) =>
    createError(
      'SANDBOX_AGENT_ALREADY_RUNNING',
      `Agent is already running for task: ${taskId}`,
      409,
      {
        taskId,
      }
    ),

  AGENT_NOT_RUNNING: (taskId: string) =>
    createError('SANDBOX_AGENT_NOT_RUNNING', `No agent running for task: ${taskId}`, 404, {
      taskId,
    }),

  AGENT_START_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_AGENT_START_FAILED',
      `Failed to start agent: ${message}`,
      500,
      undefined,
      cause
    ),

  AGENT_STOP_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_AGENT_STOP_FAILED',
      `Failed to stop agent: ${message}`,
      500,
      undefined,
      cause
    ),

  STREAMING_EXEC_NOT_SUPPORTED: createError(
    'SANDBOX_STREAMING_EXEC_NOT_SUPPORTED',
    'Sandbox provider does not support streaming exec',
    501
  ),

  API_KEY_NOT_CONFIGURED: createError(
    'SANDBOX_API_KEY_NOT_CONFIGURED',
    'Anthropic API key not configured. Set via Admin Settings or ANTHROPIC_API_KEY environment variable.',
    401
  ),

  SESSION_CREATE_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_SESSION_CREATE_FAILED',
      `Failed to create agent session: ${message}`,
      500,
      undefined,
      cause
    ),

  STREAM_CREATE_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_STREAM_CREATE_FAILED',
      `Failed to create event stream: ${message}`,
      500,
      undefined,
      cause
    ),

  STREAM_PUBLISH_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_STREAM_PUBLISH_FAILED',
      `Failed to publish event to stream: ${message}`,
      500,
      undefined,
      cause
    ),

  AGENT_RECORD_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_AGENT_RECORD_FAILED',
      `Failed to create agent database record: ${message}`,
      500,
      undefined,
      cause
    ),

  // Plan errors
  PLAN_NOT_FOUND: (taskId: string) =>
    createError('SANDBOX_PLAN_NOT_FOUND', `No pending plan found for task: ${taskId}`, 404, {
      taskId,
    }),

  PLAN_REJECTION_FAILED: (taskId: string, message: string, cause?: unknown) =>
    createError(
      'SANDBOX_PLAN_REJECTION_FAILED',
      `Failed to reject plan for task ${taskId}: ${message}`,
      500,
      { taskId },
      cause
    ),

  // Worktree errors (container flow)
  WORKTREE_CREATION_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_WORKTREE_CREATION_FAILED',
      `Failed to create worktree in sandbox: ${message}`,
      500,
      undefined,
      cause
    ),

  WORKTREE_COMMIT_FAILED: (message: string, cause?: unknown) =>
    createError(
      'SANDBOX_WORKTREE_COMMIT_FAILED',
      `Failed to commit worktree changes: ${message}`,
      500,
      undefined,
      cause
    ),

  /**
   * F06-NEW-02 (P0) / arch29-W1-E — Multi-tenant gate violation.
   *
   * Thrown when `MULTI_TENANT=true` is set in the environment but the
   * resolved sandbox mode is `shared`. Shared sandbox mode uses a single
   * Anthropic OAuth credentials file at `~/.claude/.credentials.json` and
   * a single `/workspace` bind mount inside one container — every tenant
   * agent could read every other tenant's secrets. The full multi-tenant
   * FS/UID isolation rebuild is tracked as a follow-up; this error is the
   * fail-safe.
   *
   * Resolution: configure per-codespace sandbox mode (`sandbox.mode =
   * 'per-project'` setting) or unset `MULTI_TENANT`. Self-hosted single-
   * team installs should not set `MULTI_TENANT=true`.
   */
  MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX: (codespaceId?: string) =>
    createError(
      'MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX',
      'MULTI_TENANT=true is set but sandbox mode is "shared". Shared sandbox mode is forbidden in multi-tenant deployments because all tenant agents would share a single Anthropic OAuth credentials file. Configure per-codespace sandboxes (sandbox.mode = "per-project") or unset MULTI_TENANT.',
      500,
      codespaceId ? { codespaceId } : undefined
    ),
};
