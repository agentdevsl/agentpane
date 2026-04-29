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

  // Network isolation (800-899)
  NETWORK_ISOLATION_UNSUPPORTED: 'NOMAD-800',
} as const;

export type NomadErrorId = (typeof NOMAD_ERROR_IDS)[keyof typeof NOMAD_ERROR_IDS];

export type NomadError = ReturnType<(typeof NomadErrors)[keyof typeof NomadErrors]>;

export const NomadErrors = {
  // Connection errors
  CLUSTER_UNREACHABLE: (address: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.CLUSTER_UNREACHABLE,
      `Nomad cluster unreachable at ${address}: ${reason}`,
      503,
      { address, reason, errorName: 'NOMAD_CLUSTER_UNREACHABLE' }
    ),

  CONNECTION_REFUSED: (address: string) =>
    createError(
      NOMAD_ERROR_IDS.CONNECTION_REFUSED,
      `Connection refused to Nomad at ${address}`,
      503,
      { address, errorName: 'NOMAD_CONNECTION_REFUSED' }
    ),

  AUTH_FAILED: (reason: string) =>
    createError(NOMAD_ERROR_IDS.AUTH_FAILED, `Nomad authentication failed: ${reason}`, 401, {
      errorName: 'NOMAD_AUTH_FAILED',
    }),

  TLS_ERROR: (address: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.TLS_ERROR,
      `TLS connection to Nomad at ${address} failed: ${reason}`,
      502,
      { address, reason, errorName: 'NOMAD_TLS_ERROR' }
    ),

  // Namespace errors
  NAMESPACE_NOT_FOUND: (namespace: string) =>
    createError(
      NOMAD_ERROR_IDS.NAMESPACE_NOT_FOUND,
      `Nomad namespace not found: ${namespace}`,
      404,
      { namespace, errorName: 'NOMAD_NAMESPACE_NOT_FOUND' }
    ),

  // Job lifecycle errors
  JOB_NOT_FOUND: (jobId: string) =>
    createError(NOMAD_ERROR_IDS.JOB_NOT_FOUND, `Nomad job not found: ${jobId}`, 404, {
      jobId,
      errorName: 'NOMAD_JOB_NOT_FOUND',
    }),

  JOB_CREATION_FAILED: (jobName: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_CREATION_FAILED,
      `Failed to create Nomad job ${jobName}: ${reason}`,
      500,
      { jobName, errorName: 'NOMAD_JOB_CREATION_FAILED' }
    ),

  JOB_STARTUP_TIMEOUT: (jobId: string, timeoutSeconds: number) =>
    createError(
      NOMAD_ERROR_IDS.JOB_STARTUP_TIMEOUT,
      `Nomad job ${jobId} failed to start within ${timeoutSeconds}s`,
      408,
      { jobId, timeoutSeconds, errorName: 'NOMAD_JOB_STARTUP_TIMEOUT' }
    ),

  JOB_STOP_FAILED: (jobId: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_STOP_FAILED,
      `Failed to stop Nomad job ${jobId}: ${reason}`,
      500,
      { jobId, errorName: 'NOMAD_JOB_STOP_FAILED' }
    ),

  JOB_NOT_RUNNING: (jobId: string, currentStatus: string) =>
    createError(
      NOMAD_ERROR_IDS.JOB_NOT_RUNNING,
      `Nomad job ${jobId} is not running (current: ${currentStatus})`,
      400,
      { jobId, currentStatus, errorName: 'NOMAD_JOB_NOT_RUNNING' }
    ),

  JOB_ALREADY_EXISTS: (codespaceId: string) =>
    createError(NOMAD_ERROR_IDS.JOB_ALREADY_EXISTS, 'Nomad job already exists for codespace', 409, {
      codespaceId,
      errorName: 'NOMAD_JOB_ALREADY_EXISTS',
    }),

  ALLOCATION_NOT_FOUND: (allocId: string) =>
    createError(
      NOMAD_ERROR_IDS.ALLOCATION_NOT_FOUND,
      `Nomad allocation not found: ${allocId}`,
      404,
      { allocId, errorName: 'NOMAD_ALLOCATION_NOT_FOUND' }
    ),

  ALLOCATION_FAILED: (allocId: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.ALLOCATION_FAILED,
      `Nomad allocation ${allocId} failed: ${reason}`,
      500,
      { allocId, errorName: 'NOMAD_ALLOCATION_FAILED' }
    ),

  // Exec errors
  EXEC_FAILED: (command: string, reason: string) =>
    createError(NOMAD_ERROR_IDS.EXEC_FAILED, `Command execution failed: ${reason}`, 500, {
      command,
      errorName: 'NOMAD_EXEC_FAILED',
    }),

  EXEC_TIMEOUT: (command: string, timeoutMs: number) =>
    createError(NOMAD_ERROR_IDS.EXEC_TIMEOUT, `Command timed out after ${timeoutMs}ms`, 408, {
      command,
      timeoutMs,
      errorName: 'NOMAD_EXEC_TIMEOUT',
    }),

  EXEC_CONNECTION_FAILED: (allocId: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.EXEC_CONNECTION_FAILED,
      `Failed to establish exec connection to allocation ${allocId}: ${reason}`,
      503,
      { allocId, errorName: 'NOMAD_EXEC_CONNECTION_FAILED' }
    ),

  // Image errors
  IMAGE_NOT_FOUND: (image: string) =>
    createError(NOMAD_ERROR_IDS.IMAGE_NOT_FOUND, `Image not found: ${image}`, 404, {
      image,
      errorName: 'NOMAD_IMAGE_NOT_FOUND',
    }),

  // tmux errors
  TMUX_SESSION_NOT_FOUND: (sessionName: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_SESSION_NOT_FOUND,
      `tmux session not found: ${sessionName}`,
      404,
      { sessionName, errorName: 'NOMAD_TMUX_SESSION_NOT_FOUND' }
    ),

  TMUX_SESSION_ALREADY_EXISTS: (sessionName: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_SESSION_ALREADY_EXISTS,
      `tmux session already exists: ${sessionName}`,
      409,
      { sessionName, errorName: 'NOMAD_TMUX_SESSION_ALREADY_EXISTS' }
    ),

  TMUX_CREATION_FAILED: (sessionName: string, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.TMUX_CREATION_FAILED,
      `Failed to create tmux session: ${reason}`,
      500,
      { sessionName, errorName: 'NOMAD_TMUX_CREATION_FAILED' }
    ),

  // API errors
  API_ERROR: (statusCode: number, reason: string) =>
    createError(
      NOMAD_ERROR_IDS.API_ERROR,
      `Nomad API error (${statusCode}): ${reason}`,
      statusCode,
      { errorName: 'NOMAD_API_ERROR' }
    ),

  INTERNAL_ERROR: (reason: string) =>
    createError(NOMAD_ERROR_IDS.INTERNAL_ERROR, reason, 500, {
      errorName: 'NOMAD_INTERNAL_ERROR',
    }),

  /**
   * arch29-W2-J / F04-09: Surfaced when `SANDBOX_DEFAULT_NETWORK_MODE=none` is
   * requested but the Nomad cluster cannot enforce a `network { mode = "none" }`
   * stanza (e.g. older Nomad versions, missing CNI plugins, or the operator
   * has opted out). We fail-closed at boot so the operator notices the gap
   * rather than silently shipping sandboxes with the cluster default network.
   */
  NETWORK_ISOLATION_UNSUPPORTED: (reason: string) =>
    createError(
      NOMAD_ERROR_IDS.NETWORK_ISOLATION_UNSUPPORTED,
      `Network isolation requested (SANDBOX_DEFAULT_NETWORK_MODE=none) but Nomad cannot enforce it: ${reason}`,
      500,
      { reason, errorName: 'NOMAD_NETWORK_ISOLATION_UNSUPPORTED' }
    ),
};

// Type-level check: ensure NOMAD_ERROR_IDS and NomadErrors have matching keys
type _AssertKeysMatch = keyof typeof NOMAD_ERROR_IDS extends keyof typeof NomadErrors
  ? keyof typeof NomadErrors extends keyof typeof NOMAD_ERROR_IDS
    ? true
    : never
  : never;
void (true as _AssertKeysMatch);
