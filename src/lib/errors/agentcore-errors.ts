import { createError } from './base.js';

/**
 * Reserved AgentCore error IDs for monitoring/Sentry grouping.
 * Format: AGENTCORE-NNN where NNN is a zero-padded category-specific number.
 * Ranges: 001-099 connection/auth, 100-199 runtime lifecycle,
 * 200-299 endpoint lifecycle, 300-399 invocation, 400-499 ECR,
 * 500-599 session, 700-799 API.
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

export const AgentCoreErrors = {
  // Connection / Auth errors
  AWS_CREDENTIALS_INVALID: (reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_INVALID,
      `AWS credentials invalid: ${reason}`,
      401,
      { errorName: 'AGENTCORE_AWS_CREDENTIALS_INVALID' }
    ),

  AWS_CREDENTIALS_EXPIRED: () =>
    createError(AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_EXPIRED, 'AWS credentials have expired', 401, {
      errorName: 'AGENTCORE_AWS_CREDENTIALS_EXPIRED',
    }),

  AWS_REGION_INVALID: (region: string) =>
    createError(AGENTCORE_ERROR_IDS.AWS_REGION_INVALID, `Invalid AWS region: ${region}`, 400, {
      region,
      errorName: 'AGENTCORE_AWS_REGION_INVALID',
    }),

  AWS_STS_ERROR: (reason: string) =>
    createError(AGENTCORE_ERROR_IDS.AWS_STS_ERROR, `AWS STS error: ${reason}`, 503, {
      errorName: 'AGENTCORE_AWS_STS_ERROR',
    }),

  // Runtime lifecycle errors
  RUNTIME_NOT_FOUND: (runtimeArn: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_NOT_FOUND,
      `AgentCore Runtime not found: ${runtimeArn}`,
      404,
      { runtimeArn, errorName: 'AGENTCORE_RUNTIME_NOT_FOUND' }
    ),

  RUNTIME_CREATION_FAILED: (name: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_CREATION_FAILED,
      `Failed to create AgentCore Runtime ${name}: ${reason}`,
      500,
      { name, errorName: 'AGENTCORE_RUNTIME_CREATION_FAILED' }
    ),

  RUNTIME_STARTUP_TIMEOUT: (runtimeArn: string, timeoutSeconds: number) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_STARTUP_TIMEOUT,
      `AgentCore Runtime ${runtimeArn} failed to become ACTIVE within ${timeoutSeconds}s`,
      408,
      { runtimeArn, timeoutSeconds, errorName: 'AGENTCORE_RUNTIME_STARTUP_TIMEOUT' }
    ),

  RUNTIME_DELETE_FAILED: (runtimeArn: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_DELETE_FAILED,
      `Failed to delete AgentCore Runtime ${runtimeArn}: ${reason}`,
      500,
      { runtimeArn, errorName: 'AGENTCORE_RUNTIME_DELETE_FAILED' }
    ),

  RUNTIME_NOT_ACTIVE: (runtimeArn: string, currentStatus: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_NOT_ACTIVE,
      `AgentCore Runtime ${runtimeArn} is not active (current: ${currentStatus})`,
      400,
      { runtimeArn, currentStatus, errorName: 'AGENTCORE_RUNTIME_NOT_ACTIVE' }
    ),

  RUNTIME_ALREADY_EXISTS: (projectId: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_ALREADY_EXISTS,
      'AgentCore Runtime already exists for project',
      409,
      { projectId, errorName: 'AGENTCORE_RUNTIME_ALREADY_EXISTS' }
    ),

  RUNTIME_UPDATE_FAILED: (runtimeArn: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.RUNTIME_UPDATE_FAILED,
      `Failed to update AgentCore Runtime ${runtimeArn}: ${reason}`,
      500,
      { runtimeArn, errorName: 'AGENTCORE_RUNTIME_UPDATE_FAILED' }
    ),

  // Endpoint lifecycle errors
  ENDPOINT_NOT_FOUND: (endpointName: string) =>
    createError(
      AGENTCORE_ERROR_IDS.ENDPOINT_NOT_FOUND,
      `AgentCore endpoint not found: ${endpointName}`,
      404,
      { endpointName, errorName: 'AGENTCORE_ENDPOINT_NOT_FOUND' }
    ),

  ENDPOINT_CREATION_FAILED: (runtimeArn: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.ENDPOINT_CREATION_FAILED,
      `Failed to create endpoint for Runtime ${runtimeArn}: ${reason}`,
      500,
      { runtimeArn, errorName: 'AGENTCORE_ENDPOINT_CREATION_FAILED' }
    ),

  // Invocation errors
  INVOCATION_FAILED: (runtimeArn: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.INVOCATION_FAILED,
      `Failed to invoke AgentCore Runtime: ${reason}`,
      500,
      { runtimeArn, errorName: 'AGENTCORE_INVOCATION_FAILED' }
    ),

  INVOCATION_TIMEOUT: (runtimeArn: string, timeoutMs: number) =>
    createError(
      AGENTCORE_ERROR_IDS.INVOCATION_TIMEOUT,
      `AgentCore invocation timed out after ${timeoutMs}ms`,
      408,
      { runtimeArn, timeoutMs, errorName: 'AGENTCORE_INVOCATION_TIMEOUT' }
    ),

  INVOCATION_THROTTLED: (runtimeArn: string) =>
    createError(AGENTCORE_ERROR_IDS.INVOCATION_THROTTLED, 'AgentCore invocation throttled', 429, {
      runtimeArn,
      errorName: 'AGENTCORE_INVOCATION_THROTTLED',
    }),

  // ECR errors
  ECR_AUTH_FAILED: (reason: string) =>
    createError(AGENTCORE_ERROR_IDS.ECR_AUTH_FAILED, `ECR authentication failed: ${reason}`, 401, {
      errorName: 'AGENTCORE_ECR_AUTH_FAILED',
    }),

  ECR_PUSH_FAILED: (image: string, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.ECR_PUSH_FAILED,
      `Failed to push image ${image} to ECR: ${reason}`,
      500,
      { image, errorName: 'AGENTCORE_ECR_PUSH_FAILED' }
    ),

  ECR_IMAGE_NOT_FOUND: (image: string) =>
    createError(AGENTCORE_ERROR_IDS.ECR_IMAGE_NOT_FOUND, `Image not found in ECR: ${image}`, 404, {
      image,
      errorName: 'AGENTCORE_ECR_IMAGE_NOT_FOUND',
    }),

  ECR_REPO_NOT_FOUND: (repoUri: string) =>
    createError(
      AGENTCORE_ERROR_IDS.ECR_REPO_NOT_FOUND,
      `ECR repository not found: ${repoUri}`,
      404,
      { repoUri, errorName: 'AGENTCORE_ECR_REPO_NOT_FOUND' }
    ),

  // Session errors
  SESSION_CREATION_FAILED: (reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.SESSION_CREATION_FAILED,
      `Failed to create AgentCore session: ${reason}`,
      500,
      { errorName: 'AGENTCORE_SESSION_CREATION_FAILED' }
    ),

  // API errors
  API_ERROR: (statusCode: number, reason: string) =>
    createError(
      AGENTCORE_ERROR_IDS.API_ERROR,
      `AgentCore API error (${statusCode}): ${reason}`,
      statusCode,
      { errorName: 'AGENTCORE_API_ERROR' }
    ),

  INTERNAL_ERROR: (reason: string) =>
    createError(AGENTCORE_ERROR_IDS.INTERNAL_ERROR, reason, 500, {
      errorName: 'AGENTCORE_INTERNAL_ERROR',
    }),
};

// Type-level check: ensure AGENTCORE_ERROR_IDS and AgentCoreErrors have matching keys
type _AssertKeysMatch = keyof typeof AGENTCORE_ERROR_IDS extends keyof typeof AgentCoreErrors
  ? keyof typeof AgentCoreErrors extends keyof typeof AGENTCORE_ERROR_IDS
    ? true
    : never
  : never;
void (true as _AssertKeysMatch);
