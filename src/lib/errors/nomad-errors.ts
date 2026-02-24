import type { NomadJobStatus } from '@agentpane/nomad-sandbox-sdk';
import { createError } from './base.js';

/**
 * Reserved Nomad error IDs for monitoring/Sentry grouping.
 * Format: NOMAD-NNN where NNN is a zero-padded category-specific number.
 * Ranges: 001-099 connection, 100-199 namespace, 200-299 job lifecycle,
 * 300-399 exec, 400-499 image, 500-599 tmux, 700-799 API.
 */
export const NOMAD_ERROR_IDS = {
  // Connection (001-099)
  CLUSTER_UNREACHABLE: 'NOMAD-001',
  CONNECTION_REFUSED: 'NOMAD-002',
  AUTH_FAILED: 'NOMAD-003',
  TLS_ERROR: 'NOMAD-004',

  // Namespace (100-199)
  NAMESPACE_NOT_FOUND: 'NOMAD-100',

  // Job lifecycle (200-299)
  JOB_NOT_FOUND: 'NOMAD-200',
  JOB_CREATION_FAILED: 'NOMAD-201',
  JOB_STARTUP_TIMEOUT: 'NOMAD-202',
  JOB_STOP_FAILED: 'NOMAD-203',
  JOB_NOT_RUNNING: 'NOMAD-204',
  JOB_ALREADY_EXISTS: 'NOMAD-205',
  ALLOCATION_NOT_FOUND: 'NOMAD-210',
  ALLOCATION_FAILED: 'NOMAD-211',

  // Exec (300-399)
  EXEC_FAILED: 'NOMAD-300',
  EXEC_TIMEOUT: 'NOMAD-301',
  EXEC_CONNECTION_FAILED: 'NOMAD-302',

  // Image (400-499)
  IMAGE_NOT_FOUND: 'NOMAD-400',

  // tmux (500-599)
  TMUX_SESSION_NOT_FOUND: 'NOMAD-500',
  TMUX_SESSION_ALREADY_EXISTS: 'NOMAD-501',
  TMUX_CREATION_FAILED: 'NOMAD-502',

  // API (700-799)
  API_ERROR: 'NOMAD-700',
  INTERNAL_ERROR: 'NOMAD-701',
} as const;

export type NomadErrorId = (typeof NOMAD_ERROR_IDS)[keyof typeof NOMAD_ERROR_IDS];

export type NomadError = ReturnType<(typeof NomadErrors)[keyof typeof NomadErrors]>;

export const NomadErrors = {
  // Connection errors
  CLUSTER_UNREACHABLE: (address: string, reason: string) =>
    createError(
      'NOMAD_CLUSTER_UNREACHABLE',
      `Nomad cluster unreachable at ${address}: ${reason}`,
      503,
      { address, reason }
    ),

  CONNECTION_REFUSED: (address: string) =>
    createError('NOMAD_CONNECTION_REFUSED', `Connection refused to Nomad at ${address}`, 503, {
      address,
    }),

  AUTH_FAILED: (reason: string) =>
    createError('NOMAD_AUTH_FAILED', `Nomad authentication failed: ${reason}`, 401),

  TLS_ERROR: (address: string, reason: string) =>
    createError('NOMAD_TLS_ERROR', `TLS connection to Nomad at ${address} failed: ${reason}`, 502, {
      address,
      reason,
    }),

  // Namespace errors
  NAMESPACE_NOT_FOUND: (namespace: string) =>
    createError('NOMAD_NAMESPACE_NOT_FOUND', `Nomad namespace not found: ${namespace}`, 404, {
      namespace,
    }),

  // Job lifecycle errors
  JOB_NOT_FOUND: (jobId: string) =>
    createError('NOMAD_JOB_NOT_FOUND', `Nomad job not found: ${jobId}`, 404, { jobId }),

  JOB_CREATION_FAILED: (jobName: string, reason: string) =>
    createError(
      'NOMAD_JOB_CREATION_FAILED',
      `Failed to create Nomad job ${jobName}: ${reason}`,
      500,
      { jobName }
    ),

  JOB_STARTUP_TIMEOUT: (jobId: string, timeoutSeconds: number) =>
    createError(
      'NOMAD_JOB_STARTUP_TIMEOUT',
      `Nomad job ${jobId} failed to start within ${timeoutSeconds}s`,
      408,
      { jobId, timeoutSeconds }
    ),

  JOB_STOP_FAILED: (jobId: string, reason: string) =>
    createError('NOMAD_JOB_STOP_FAILED', `Failed to stop Nomad job ${jobId}: ${reason}`, 500, {
      jobId,
    }),

  JOB_NOT_RUNNING: (jobId: string, currentStatus: NomadJobStatus | string) =>
    createError(
      'NOMAD_JOB_NOT_RUNNING',
      `Nomad job ${jobId} is not running (current: ${currentStatus})`,
      400,
      { jobId, currentStatus }
    ),

  JOB_ALREADY_EXISTS: (projectId: string) =>
    createError('NOMAD_JOB_ALREADY_EXISTS', 'Nomad job already exists for project', 409, {
      projectId,
    }),

  ALLOCATION_NOT_FOUND: (allocId: string) =>
    createError('NOMAD_ALLOCATION_NOT_FOUND', `Nomad allocation not found: ${allocId}`, 404, {
      allocId,
    }),

  ALLOCATION_FAILED: (allocId: string, reason: string) =>
    createError('NOMAD_ALLOCATION_FAILED', `Nomad allocation ${allocId} failed: ${reason}`, 500, {
      allocId,
    }),

  // Exec errors
  EXEC_FAILED: (command: string, reason: string) =>
    createError('NOMAD_EXEC_FAILED', `Command execution failed: ${reason}`, 500, {
      command,
    }),

  EXEC_TIMEOUT: (command: string, timeoutMs: number) =>
    createError('NOMAD_EXEC_TIMEOUT', `Command timed out after ${timeoutMs}ms`, 408, {
      command,
      timeoutMs,
    }),

  EXEC_CONNECTION_FAILED: (allocId: string, reason: string) =>
    createError(
      'NOMAD_EXEC_CONNECTION_FAILED',
      `Failed to establish exec connection to allocation ${allocId}: ${reason}`,
      503,
      { allocId }
    ),

  // Image errors
  IMAGE_NOT_FOUND: (image: string) =>
    createError('NOMAD_IMAGE_NOT_FOUND', `Image not found: ${image}`, 404, { image }),

  // tmux errors
  TMUX_SESSION_NOT_FOUND: (sessionName: string) =>
    createError('NOMAD_TMUX_SESSION_NOT_FOUND', `tmux session not found: ${sessionName}`, 404, {
      sessionName,
    }),

  TMUX_SESSION_ALREADY_EXISTS: (sessionName: string) =>
    createError(
      'NOMAD_TMUX_SESSION_ALREADY_EXISTS',
      `tmux session already exists: ${sessionName}`,
      409,
      {
        sessionName,
      }
    ),

  TMUX_CREATION_FAILED: (sessionName: string, reason: string) =>
    createError('NOMAD_TMUX_CREATION_FAILED', `Failed to create tmux session: ${reason}`, 500, {
      sessionName,
    }),

  // API errors
  API_ERROR: (statusCode: number, reason: string) =>
    createError('NOMAD_API_ERROR', `Nomad API error (${statusCode}): ${reason}`, statusCode),

  INTERNAL_ERROR: (reason: string) => createError('NOMAD_INTERNAL_ERROR', reason, 500),
};
