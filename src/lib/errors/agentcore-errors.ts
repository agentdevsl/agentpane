import { createError } from './base.js';

/**
 * Reserved AgentCore error IDs for monitoring/Sentry grouping.
 * Format: AGENTCORE-NNN where NNN is a zero-padded category-specific number.
 * Ranges: 001-099 connection/auth, 100-199 runtime lifecycle,
 * 200-299 endpoint lifecycle, 300-399 invocation, 400-499 ECR,
 * 500-599 session, 600-699 reserved for future use, 700-799 API.
 */
export const AGENTCORE_ERROR_IDS = {
  // Connection / Auth (001-099)
  AWS_CREDENTIALS_INVALID: 'AGENTCORE-001',
  AWS_CREDENTIALS_EXPIRED: 'AGENTCORE-002',
  AWS_REGION_INVALID: 'AGENTCORE-003',
  AWS_STS_ERROR: 'AGENTCORE-004',

  // Runtime lifecycle (100-199)
  RUNTIME_NOT_FOUND: 'AGENTCORE-100',
  RUNTIME_CREATION_FAILED: 'AGENTCORE-101',
  RUNTIME_STARTUP_TIMEOUT: 'AGENTCORE-102',
  RUNTIME_DELETE_FAILED: 'AGENTCORE-103',
  RUNTIME_NOT_ACTIVE: 'AGENTCORE-104',
  RUNTIME_ALREADY_EXISTS: 'AGENTCORE-105',
  RUNTIME_UPDATE_FAILED: 'AGENTCORE-106',

  // Endpoint lifecycle (200-299)
  ENDPOINT_NOT_FOUND: 'AGENTCORE-200',
  ENDPOINT_CREATION_FAILED: 'AGENTCORE-201',

  // Invocation (300-399)
  INVOCATION_FAILED: 'AGENTCORE-300',
  INVOCATION_TIMEOUT: 'AGENTCORE-301',
  INVOCATION_THROTTLED: 'AGENTCORE-302',

  // ECR (400-499)
  ECR_AUTH_FAILED: 'AGENTCORE-400',
  ECR_PUSH_FAILED: 'AGENTCORE-401',
  ECR_IMAGE_NOT_FOUND: 'AGENTCORE-402',
  ECR_REPO_NOT_FOUND: 'AGENTCORE-403',

  // Session (500-599)
  SESSION_CREATION_FAILED: 'AGENTCORE-500',

  // API (700-799)
  API_ERROR: 'AGENTCORE-700',
  INTERNAL_ERROR: 'AGENTCORE-701',
} as const;

export type AgentCoreErrorId = (typeof AGENTCORE_ERROR_IDS)[keyof typeof AGENTCORE_ERROR_IDS];

export type AgentCoreError = ReturnType<(typeof AgentCoreErrors)[keyof typeof AgentCoreErrors]>;

function agentcoreError(
  key: string,
  httpStatus: number,
  message: string,
  details?: Record<string, unknown>
) {
  return createError(
    AGENTCORE_ERROR_IDS[key as keyof typeof AGENTCORE_ERROR_IDS],
    message,
    httpStatus,
    { errorName: `AGENTCORE_${key}`, ...details }
  );
}

export const AgentCoreErrors = {
  // Connection / Auth errors
  AWS_CREDENTIALS_INVALID: (reason: string) =>
    agentcoreError('AWS_CREDENTIALS_INVALID', 401, `AWS credentials invalid: ${reason}`),

  AWS_CREDENTIALS_EXPIRED: () =>
    agentcoreError('AWS_CREDENTIALS_EXPIRED', 401, 'AWS credentials have expired'),

  AWS_REGION_INVALID: (region: string) =>
    agentcoreError('AWS_REGION_INVALID', 400, `Invalid AWS region: ${region}`, { region }),

  AWS_STS_ERROR: (reason: string) =>
    agentcoreError('AWS_STS_ERROR', 503, `AWS STS error: ${reason}`),

  // Runtime lifecycle errors
  RUNTIME_NOT_FOUND: (runtimeArn: string) =>
    agentcoreError('RUNTIME_NOT_FOUND', 404, `AgentCore Runtime not found: ${runtimeArn}`, {
      runtimeArn,
    }),

  RUNTIME_CREATION_FAILED: (name: string, reason: string) =>
    agentcoreError(
      'RUNTIME_CREATION_FAILED',
      500,
      `Failed to create AgentCore Runtime ${name}: ${reason}`,
      { name }
    ),

  RUNTIME_STARTUP_TIMEOUT: (runtimeArn: string, timeoutSeconds: number) =>
    agentcoreError(
      'RUNTIME_STARTUP_TIMEOUT',
      408,
      `AgentCore Runtime ${runtimeArn} failed to become ACTIVE within ${timeoutSeconds}s`,
      { runtimeArn, timeoutSeconds }
    ),

  RUNTIME_DELETE_FAILED: (runtimeArn: string, reason: string) =>
    agentcoreError(
      'RUNTIME_DELETE_FAILED',
      500,
      `Failed to delete AgentCore Runtime ${runtimeArn}: ${reason}`,
      { runtimeArn }
    ),

  RUNTIME_NOT_ACTIVE: (runtimeArn: string, currentStatus: string) =>
    agentcoreError(
      'RUNTIME_NOT_ACTIVE',
      400,
      `AgentCore Runtime ${runtimeArn} is not active (current: ${currentStatus})`,
      { runtimeArn, currentStatus }
    ),

  RUNTIME_ALREADY_EXISTS: (projectId: string) =>
    agentcoreError('RUNTIME_ALREADY_EXISTS', 409, 'AgentCore Runtime already exists for project', {
      projectId,
    }),

  RUNTIME_UPDATE_FAILED: (runtimeArn: string, reason: string) =>
    agentcoreError(
      'RUNTIME_UPDATE_FAILED',
      500,
      `Failed to update AgentCore Runtime ${runtimeArn}: ${reason}`,
      { runtimeArn }
    ),

  // Endpoint lifecycle errors
  ENDPOINT_NOT_FOUND: (endpointName: string) =>
    agentcoreError('ENDPOINT_NOT_FOUND', 404, `AgentCore endpoint not found: ${endpointName}`, {
      endpointName,
    }),

  ENDPOINT_CREATION_FAILED: (runtimeArn: string, reason: string) =>
    agentcoreError(
      'ENDPOINT_CREATION_FAILED',
      500,
      `Failed to create endpoint for Runtime ${runtimeArn}: ${reason}`,
      { runtimeArn }
    ),

  // Invocation errors
  INVOCATION_FAILED: (runtimeArn: string, reason: string) =>
    agentcoreError('INVOCATION_FAILED', 500, `Failed to invoke AgentCore Runtime: ${reason}`, {
      runtimeArn,
    }),

  INVOCATION_TIMEOUT: (runtimeArn: string, timeoutMs: number) =>
    agentcoreError(
      'INVOCATION_TIMEOUT',
      408,
      `AgentCore invocation timed out after ${timeoutMs}ms`,
      { runtimeArn, timeoutMs }
    ),

  INVOCATION_THROTTLED: (runtimeArn: string) =>
    agentcoreError('INVOCATION_THROTTLED', 429, 'AgentCore invocation throttled', { runtimeArn }),

  // ECR errors
  ECR_AUTH_FAILED: (reason: string) =>
    agentcoreError('ECR_AUTH_FAILED', 401, `ECR authentication failed: ${reason}`),

  ECR_PUSH_FAILED: (image: string, reason: string) =>
    agentcoreError('ECR_PUSH_FAILED', 500, `Failed to push image ${image} to ECR: ${reason}`, {
      image,
    }),

  ECR_IMAGE_NOT_FOUND: (image: string) =>
    agentcoreError('ECR_IMAGE_NOT_FOUND', 404, `Image not found in ECR: ${image}`, { image }),

  ECR_REPO_NOT_FOUND: (repoUri: string) =>
    agentcoreError('ECR_REPO_NOT_FOUND', 404, `ECR repository not found: ${repoUri}`, {
      repoUri,
    }),

  // Session errors
  SESSION_CREATION_FAILED: (reason: string) =>
    agentcoreError('SESSION_CREATION_FAILED', 500, `Failed to create AgentCore session: ${reason}`),

  // API errors
  API_ERROR: (statusCode: number, reason: string) =>
    agentcoreError('API_ERROR', statusCode, `AgentCore API error (${statusCode}): ${reason}`),

  INTERNAL_ERROR: (reason: string) => agentcoreError('INTERNAL_ERROR', 500, reason),
};

// Type-level check: ensure AGENTCORE_ERROR_IDS and AgentCoreErrors have matching keys
type _AssertKeysMatch = keyof typeof AGENTCORE_ERROR_IDS extends keyof typeof AgentCoreErrors
  ? keyof typeof AgentCoreErrors extends keyof typeof AGENTCORE_ERROR_IDS
    ? true
    : never
  : never;
void (true as _AssertKeysMatch);
