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
  IMAGE_NOT_FOUND: 'NOMAD-402',

  // tmux (500-599)
  TMUX_SESSION_NOT_FOUND: 'NOMAD-500',
  TMUX_SESSION_ALREADY_EXISTS: 'NOMAD-501',
  TMUX_CREATION_FAILED: 'NOMAD-502',

  // API (700-799)
  API_ERROR: 'NOMAD-700',
  INTERNAL_ERROR: 'NOMAD-701',
} as const;

export type NomadErrorId = (typeof NOMAD_ERROR_IDS)[keyof typeof NOMAD_ERROR_IDS];

export const NomadErrors = {
  // Connection errors
  CLUSTER_UNREACHABLE: (address: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.CLUSTER_UNREACHABLE,
      `Nomad cluster unreachable at ${address}: ${message}`,
      503,
      { address, message }
    ),

  CONNECTION_REFUSED: (address: string) =>
    createError(
      NOMAD_ERROR_IDS.CONNECTION_REFUSED,
      `Connection refused to Nomad at ${address}`,
      503,
      {
        address,
      }
    ),

  AUTH_FAILED: (message: string) =>
    createError(NOMAD_ERROR_IDS.AUTH_FAILED, `Nomad authentication failed: ${message}`, 401),

  TLS_ERROR: (address: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.TLS_ERROR,
      `TLS connection to Nomad at ${address} failed: ${message}`,
      502,
      { address, message }
    ),

  // Namespace errors
  NAMESPACE_NOT_FOUND: (namespace: string) =>
    createError(
      NOMAD_ERROR_IDS.NAMESPACE_NOT_FOUND,
      `Nomad namespace not found: ${namespace}`,
      404,
      {
        namespace,
      }
    ),

  // Job lifecycle errors
  JOB_NOT_FOUND: (jobId: string) =>
    createError(NOMAD_ERROR_IDS.JOB_NOT_FOUND, `Nomad job not found: ${jobId}`, 404, { jobId }),

  JOB_CREATION_FAILED: (jobName: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_CREATION_FAILED,
      `Failed to create Nomad job ${jobName}: ${message}`,
      500,
      { jobName }
    ),

  JOB_STARTUP_TIMEOUT: (jobId: string, timeoutSeconds: number) =>
    createError(
      NOMAD_ERROR_IDS.JOB_STARTUP_TIMEOUT,
      `Nomad job ${jobId} failed to start within ${timeoutSeconds}s`,
      408,
      { jobId, timeoutSeconds }
    ),

  JOB_STOP_FAILED: (jobId: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_STOP_FAILED,
      `Failed to stop Nomad job ${jobId}: ${message}`,
      500,
      {
        jobId,
      }
    ),

  // TODO: type currentStatus as NomadJobStatus when SDK types are re-exported
  JOB_NOT_RUNNING: (jobId: string, currentStatus: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_NOT_RUNNING,
      `Nomad job ${jobId} is not running (current: ${currentStatus})`,
      400,
      { jobId, currentStatus }
    ),

  JOB_ALREADY_EXISTS: (projectId: string) =>
    createError(NOMAD_ERROR_IDS.JOB_ALREADY_EXISTS, 'Nomad job already exists for project', 409, {
      projectId,
    }),

  ALLOCATION_NOT_FOUND: (allocId: string) =>
    createError(
      NOMAD_ERROR_IDS.ALLOCATION_NOT_FOUND,
      `Nomad allocation not found: ${allocId}`,
      404,
      {
        allocId,
      }
    ),

  ALLOCATION_FAILED: (allocId: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.ALLOCATION_FAILED,
      `Nomad allocation ${allocId} failed: ${message}`,
      500,
      {
        allocId,
      }
    ),

  // Exec errors
  EXEC_FAILED: (command: string, message: string) =>
    createError(NOMAD_ERROR_IDS.EXEC_FAILED, `Command execution failed: ${message}`, 500, {
      command,
    }),

  EXEC_TIMEOUT: (command: string, timeoutMs: number) =>
    createError(NOMAD_ERROR_IDS.EXEC_TIMEOUT, `Command timed out after ${timeoutMs}ms`, 408, {
      command,
      timeoutMs,
    }),

  EXEC_CONNECTION_FAILED: (allocId: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.EXEC_CONNECTION_FAILED,
      `Failed to establish exec connection to allocation ${allocId}: ${message}`,
      503,
      { allocId }
    ),

  // Image errors
  IMAGE_NOT_FOUND: (image: string) =>
    createError(NOMAD_ERROR_IDS.IMAGE_NOT_FOUND, `Image not found: ${image}`, 404, { image }),

  // tmux errors
  TMUX_SESSION_NOT_FOUND: (sessionName: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_SESSION_NOT_FOUND,
      `tmux session not found: ${sessionName}`,
      404,
      {
        sessionName,
      }
    ),

  TMUX_SESSION_ALREADY_EXISTS: (sessionName: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_SESSION_ALREADY_EXISTS,
      `tmux session already exists: ${sessionName}`,
      409,
      {
        sessionName,
      }
    ),

  TMUX_CREATION_FAILED: (sessionName: string, message: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_CREATION_FAILED,
      `Failed to create tmux session: ${message}`,
      500,
      {
        sessionName,
      }
    ),

  // API errors
  API_ERROR: (statusCode: number, message: string) =>
    createError(
      NOMAD_ERROR_IDS.API_ERROR,
      `Nomad API error (${statusCode}): ${message}`,
      statusCode
    ),

  INTERNAL_ERROR: (message: string) => createError(NOMAD_ERROR_IDS.INTERNAL_ERROR, message, 500),
};
