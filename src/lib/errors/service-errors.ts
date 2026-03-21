/**
 * Common service-layer error catalog entries.
 *
 * These errors cover cross-cutting service concerns that don't belong to a
 * specific domain error module (task, agent, session, etc.). They replace raw
 * `throw new Error(...)` calls that previously bypassed the typed error catalog.
 *
 * @see CQ-027 in specs/reviews/2026-03-architecture/FINDINGS-MATRIX.md
 */
import { createError } from './base.js';

export const ServiceErrors = {
  // DurableStreams
  STREAM_ID_REQUIRED: createError(
    'STREAM_ID_REQUIRED',
    'streamId is required and must be a non-empty string',
    400
  ),
  STREAM_CREATE_FAILED: (id: string, reason: string) =>
    createError('STREAM_CREATE_FAILED', `Failed to create stream '${id}': ${reason}`, 500, {
      streamId: id,
      reason,
    }),
  STREAM_PUBLISH_FAILED: (streamId: string, eventType: string, reason: string) =>
    createError(
      'STREAM_PUBLISH_FAILED',
      `Failed to publish event '${eventType}' to stream '${streamId}': ${reason}`,
      500,
      { streamId, eventType, reason }
    ),

  // Worktree shell validation
  SHELL_INJECTION_DETECTED: (command: string) =>
    createError(
      'SHELL_INJECTION_DETECTED',
      'Command rejected: contains shell metacharacters that could enable injection',
      400,
      { commandPreview: command.slice(0, 80) }
    ),
  COMMAND_FAILED: (exitCode: number, stderr: string) =>
    createError('COMMAND_FAILED', `Command failed with exit code ${exitCode}`, 500, {
      exitCode,
      stderr: stderr.slice(0, 500),
    }),

  // Crypto / decryption
  DECRYPT_FAILED: (service: string) =>
    createError(
      'DECRYPT_FAILED',
      `Failed to decrypt key for ${service}. The encryption key may have changed or data is corrupted.`,
      500,
      { service }
    ),

  // Terraform compose
  STREAMS_REQUIRED: createError(
    'STREAMS_REQUIRED',
    'DurableStreamsService is required for event delivery',
    500
  ),

  // Scheduler
  INVALID_SCHEDULE_TYPE: (scheduleType: string) =>
    createError(
      'INVALID_SCHEDULE_TYPE',
      `Unknown scheduleType "${scheduleType}". Expected "interval" or "cron".`,
      400,
      { scheduleType }
    ),

  // Sandbox
  SANDBOX_NOT_READY: (codespaceId: string, maxWaitMs: number) =>
    createError(
      'SANDBOX_NOT_READY',
      `Sandbox for codespace ${codespaceId} did not become ready within ${maxWaitMs}ms`,
      504,
      { codespaceId, maxWaitMs }
    ),
} as const;

export type ServiceError =
  | typeof ServiceErrors.STREAM_ID_REQUIRED
  | ReturnType<typeof ServiceErrors.STREAM_CREATE_FAILED>
  | ReturnType<typeof ServiceErrors.STREAM_PUBLISH_FAILED>
  | ReturnType<typeof ServiceErrors.SHELL_INJECTION_DETECTED>
  | ReturnType<typeof ServiceErrors.COMMAND_FAILED>
  | ReturnType<typeof ServiceErrors.DECRYPT_FAILED>
  | typeof ServiceErrors.STREAMS_REQUIRED
  | ReturnType<typeof ServiceErrors.INVALID_SCHEDULE_TYPE>
  | ReturnType<typeof ServiceErrors.SANDBOX_NOT_READY>;
