import { AppErrorClass, createError } from './base.js';

/**
 * Reserved AgentCore error IDs for monitoring/Sentry grouping.
 * Format: AGENTCORE-NNN where NNN is a zero-padded category-specific number.
 * Ranges: 001-099 connection/auth, 600-699 streaming/session, 700-799 API.
 */
export const AGENTCORE_ERROR_IDS = {
  AWS_CREDENTIALS_INVALID: 'AGENTCORE-001',
  AWS_CREDENTIALS_EXPIRED: 'AGENTCORE-002',
  AWS_REGION_INVALID: 'AGENTCORE-003',
  AWS_STS_ERROR: 'AGENTCORE-004',

  STREAMING_ERROR: 'AGENTCORE-600',
  SESSION_CREATE_FAILED: 'AGENTCORE-601',
  SESSION_INVOKE_FAILED: 'AGENTCORE-602',

  API_ERROR: 'AGENTCORE-700',
  INTERNAL_ERROR: 'AGENTCORE-701',
} as const;

export function isAgentCoreError(error: unknown): boolean {
  return error instanceof AppErrorClass && error.code.startsWith('AGENTCORE-');
}

function agentcoreError(
  key: keyof typeof AGENTCORE_ERROR_IDS,
  httpStatus: number,
  message: string,
  details?: Record<string, unknown>
) {
  return createError(AGENTCORE_ERROR_IDS[key], message, httpStatus, {
    errorName: `AGENTCORE_${key}`,
    ...details,
  });
}

export const AgentCoreErrors = {
  AWS_CREDENTIALS_INVALID: (reason: string) =>
    agentcoreError('AWS_CREDENTIALS_INVALID', 401, `AWS credentials invalid: ${reason}`),

  AWS_CREDENTIALS_EXPIRED: () =>
    agentcoreError('AWS_CREDENTIALS_EXPIRED', 401, 'AWS credentials have expired'),

  AWS_REGION_INVALID: (region: string) =>
    agentcoreError('AWS_REGION_INVALID', 400, `Invalid AWS region: ${region}`, { region }),

  AWS_STS_ERROR: (reason: string) =>
    agentcoreError('AWS_STS_ERROR', 503, `AWS STS error: ${reason}`),

  STREAMING_ERROR: (reason: string) =>
    agentcoreError('STREAMING_ERROR', 502, `AgentCore streaming error: ${reason}`),

  SESSION_CREATE_FAILED: (reason: string) =>
    agentcoreError('SESSION_CREATE_FAILED', 502, `AgentCore session creation failed: ${reason}`),

  SESSION_INVOKE_FAILED: (reason: string) =>
    agentcoreError('SESSION_INVOKE_FAILED', 502, `AgentCore invocation failed: ${reason}`),

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
