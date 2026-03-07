import { describe, expect, it } from 'vitest';
import { AGENTCORE_ERROR_IDS, AgentCoreErrors, isAgentCoreError } from '../agentcore-errors.js';
import { AppErrorClass } from '../base.js';

describe('AGENTCORE_ERROR_IDS', () => {
  it.each([
    ['AWS_CREDENTIALS_INVALID', 'AGENTCORE-001'],
    ['AWS_CREDENTIALS_EXPIRED', 'AGENTCORE-002'],
    ['AWS_REGION_INVALID', 'AGENTCORE-003'],
    ['AWS_STS_ERROR', 'AGENTCORE-004'],
    ['RUNTIME_NOT_FOUND', 'AGENTCORE-100'],
    ['RUNTIME_CREATION_FAILED', 'AGENTCORE-101'],
    ['RUNTIME_STARTUP_TIMEOUT', 'AGENTCORE-102'],
    ['RUNTIME_DELETE_FAILED', 'AGENTCORE-103'],
    ['RUNTIME_NOT_ACTIVE', 'AGENTCORE-104'],
    ['RUNTIME_ALREADY_EXISTS', 'AGENTCORE-105'],
    ['RUNTIME_UPDATE_FAILED', 'AGENTCORE-106'],
    ['ENDPOINT_NOT_FOUND', 'AGENTCORE-200'],
    ['ENDPOINT_CREATION_FAILED', 'AGENTCORE-201'],
    ['INVOCATION_FAILED', 'AGENTCORE-300'],
    ['INVOCATION_TIMEOUT', 'AGENTCORE-301'],
    ['INVOCATION_THROTTLED', 'AGENTCORE-302'],
    ['ECR_AUTH_FAILED', 'AGENTCORE-400'],
    ['ECR_PUSH_FAILED', 'AGENTCORE-401'],
    ['ECR_IMAGE_NOT_FOUND', 'AGENTCORE-402'],
    ['ECR_REPO_NOT_FOUND', 'AGENTCORE-403'],
    ['SESSION_CREATION_FAILED', 'AGENTCORE-500'],
    ['API_ERROR', 'AGENTCORE-700'],
    ['INTERNAL_ERROR', 'AGENTCORE-701'],
  ] as const)('%s has code %s', (key, expectedCode) => {
    expect(AGENTCORE_ERROR_IDS[key as keyof typeof AGENTCORE_ERROR_IDS]).toBe(expectedCode);
  });
});

describe('AgentCoreErrors', () => {
  it.each([
    {
      name: 'AWS_CREDENTIALS_INVALID',
      factory: () => AgentCoreErrors.AWS_CREDENTIALS_INVALID('invalid access key'),
      code: 'AGENTCORE-001',
      status: 401,
      messageContains: ['invalid access key'],
    },
    {
      name: 'AWS_CREDENTIALS_EXPIRED',
      factory: () => AgentCoreErrors.AWS_CREDENTIALS_EXPIRED(),
      code: 'AGENTCORE-002',
      status: 401,
      messageContains: ['expired'],
    },
    {
      name: 'AWS_REGION_INVALID',
      factory: () => AgentCoreErrors.AWS_REGION_INVALID('xx-invalid-1'),
      code: 'AGENTCORE-003',
      status: 400,
      messageContains: ['xx-invalid-1'],
      details: { region: 'xx-invalid-1' },
    },
    {
      name: 'AWS_STS_ERROR',
      factory: () => AgentCoreErrors.AWS_STS_ERROR('token expired'),
      code: 'AGENTCORE-004',
      status: 503,
      messageContains: ['token expired'],
    },
    {
      name: 'RUNTIME_NOT_FOUND',
      factory: () =>
        AgentCoreErrors.RUNTIME_NOT_FOUND('arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-abc'),
      code: 'AGENTCORE-100',
      status: 404,
      messageContains: ['arn:aws:bedrock-agentcore'],
      details: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-abc' },
    },
    {
      name: 'RUNTIME_CREATION_FAILED',
      factory: () =>
        AgentCoreErrors.RUNTIME_CREATION_FAILED('agentpane-proj-1', 'insufficient capacity'),
      code: 'AGENTCORE-101',
      status: 500,
      messageContains: ['agentpane-proj-1', 'insufficient capacity'],
      details: { name: 'agentpane-proj-1' },
    },
    {
      name: 'RUNTIME_STARTUP_TIMEOUT',
      factory: () => AgentCoreErrors.RUNTIME_STARTUP_TIMEOUT('arn:runtime/rt-1', 300),
      code: 'AGENTCORE-102',
      status: 408,
      messageContains: ['arn:runtime/rt-1', '300'],
      details: { runtimeArn: 'arn:runtime/rt-1', timeoutSeconds: 300 },
    },
    {
      name: 'RUNTIME_DELETE_FAILED',
      factory: () => AgentCoreErrors.RUNTIME_DELETE_FAILED('arn:runtime/rt-1', 'still running'),
      code: 'AGENTCORE-103',
      status: 500,
      messageContains: ['arn:runtime/rt-1'],
      details: { runtimeArn: 'arn:runtime/rt-1' },
    },
    {
      name: 'RUNTIME_NOT_ACTIVE',
      factory: () => AgentCoreErrors.RUNTIME_NOT_ACTIVE('arn:runtime/rt-1', 'creating'),
      code: 'AGENTCORE-104',
      status: 400,
      messageContains: ['arn:runtime/rt-1', 'creating'],
      details: { runtimeArn: 'arn:runtime/rt-1', currentStatus: 'creating' },
    },
    {
      name: 'RUNTIME_ALREADY_EXISTS',
      factory: () => AgentCoreErrors.RUNTIME_ALREADY_EXISTS('proj-123'),
      code: 'AGENTCORE-105',
      status: 409,
      details: { projectId: 'proj-123' },
    },
    {
      name: 'RUNTIME_UPDATE_FAILED',
      factory: () => AgentCoreErrors.RUNTIME_UPDATE_FAILED('arn:runtime/rt-1', 'validation error'),
      code: 'AGENTCORE-106',
      status: 500,
      messageContains: ['arn:runtime/rt-1', 'validation error'],
    },
    {
      name: 'ENDPOINT_NOT_FOUND',
      factory: () => AgentCoreErrors.ENDPOINT_NOT_FOUND('my-endpoint'),
      code: 'AGENTCORE-200',
      status: 404,
      messageContains: ['my-endpoint'],
      details: { endpointName: 'my-endpoint' },
    },
    {
      name: 'ENDPOINT_CREATION_FAILED',
      factory: () => AgentCoreErrors.ENDPOINT_CREATION_FAILED('arn:runtime/rt-1', 'quota exceeded'),
      code: 'AGENTCORE-201',
      status: 500,
      messageContains: ['arn:runtime/rt-1', 'quota exceeded'],
    },
    {
      name: 'INVOCATION_FAILED',
      factory: () => AgentCoreErrors.INVOCATION_FAILED('arn:runtime/rt-1', 'exec ls: exit code 1'),
      code: 'AGENTCORE-300',
      status: 500,
      messageContains: ['exit code 1'],
      details: { runtimeArn: 'arn:runtime/rt-1' },
    },
    {
      name: 'INVOCATION_TIMEOUT',
      factory: () => AgentCoreErrors.INVOCATION_TIMEOUT('arn:runtime/rt-1', 30000),
      code: 'AGENTCORE-301',
      status: 408,
      messageContains: ['30000'],
      details: { runtimeArn: 'arn:runtime/rt-1', timeoutMs: 30000 },
    },
    {
      name: 'INVOCATION_THROTTLED',
      factory: () => AgentCoreErrors.INVOCATION_THROTTLED('arn:runtime/rt-1'),
      code: 'AGENTCORE-302',
      status: 429,
      messageContains: ['throttled'],
      details: { runtimeArn: 'arn:runtime/rt-1' },
    },
    {
      name: 'ECR_AUTH_FAILED',
      factory: () => AgentCoreErrors.ECR_AUTH_FAILED('token expired'),
      code: 'AGENTCORE-400',
      status: 401,
      messageContains: ['token expired'],
    },
    {
      name: 'ECR_PUSH_FAILED',
      factory: () => AgentCoreErrors.ECR_PUSH_FAILED('my-image:latest', 'access denied'),
      code: 'AGENTCORE-401',
      status: 500,
      messageContains: ['my-image:latest', 'access denied'],
      details: { image: 'my-image:latest' },
    },
    {
      name: 'ECR_IMAGE_NOT_FOUND',
      factory: () => AgentCoreErrors.ECR_IMAGE_NOT_FOUND('node:22-slim'),
      code: 'AGENTCORE-402',
      status: 404,
      messageContains: ['node:22-slim'],
      details: { image: 'node:22-slim' },
    },
    {
      name: 'ECR_REPO_NOT_FOUND',
      factory: () =>
        AgentCoreErrors.ECR_REPO_NOT_FOUND('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo'),
      code: 'AGENTCORE-403',
      status: 404,
      messageContains: ['my-repo'],
      details: { repoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo' },
    },
    {
      name: 'SESSION_CREATION_FAILED',
      factory: () => AgentCoreErrors.SESSION_CREATION_FAILED('timeout'),
      code: 'AGENTCORE-500',
      status: 500,
      messageContains: ['timeout'],
    },
    {
      name: 'API_ERROR',
      factory: () => AgentCoreErrors.API_ERROR(502, 'Bad Gateway'),
      code: 'AGENTCORE-700',
      status: 502,
      messageContains: ['502', 'Bad Gateway'],
    },
    {
      name: 'INTERNAL_ERROR',
      factory: () => AgentCoreErrors.INTERNAL_ERROR('unexpected state'),
      code: 'AGENTCORE-701',
      status: 500,
      messageEquals: 'unexpected state',
    },
  ] as const)('$name returns code=$code status=$status', ({
    factory,
    code,
    status,
    messageContains,
    messageEquals,
    details,
  }) => {
    const error = factory();

    expect(error).toBeInstanceOf(AppErrorClass);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);

    if (messageEquals) {
      expect(error.message).toBe(messageEquals);
    }
    if (messageContains) {
      for (const fragment of messageContains) {
        expect(error.message).toContain(fragment);
      }
    }
    if (details) {
      expect(error.details).toMatchObject(details);
    }
  });

  it('every error code uses the corresponding AGENTCORE_ERROR_IDS value', () => {
    const errorIdKeys = Object.keys(AGENTCORE_ERROR_IDS) as Array<keyof typeof AGENTCORE_ERROR_IDS>;
    const agentCoreErrorKeys = Object.keys(AgentCoreErrors) as Array<keyof typeof AgentCoreErrors>;

    expect(errorIdKeys.sort()).toEqual(agentCoreErrorKeys.sort());
  });

  it('details include errorName for debugging', () => {
    const error = AgentCoreErrors.AWS_CREDENTIALS_INVALID('test');
    expect(error.details).toHaveProperty('errorName', 'AGENTCORE_AWS_CREDENTIALS_INVALID');
  });
});

describe('isAgentCoreError', () => {
  it('returns true for AgentCore errors', () => {
    const error = AgentCoreErrors.AWS_CREDENTIALS_INVALID('test');
    expect(isAgentCoreError(error)).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isAgentCoreError(new Error('not agentcore'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAgentCoreError(null)).toBe(false);
    expect(isAgentCoreError('string')).toBe(false);
    expect(isAgentCoreError(42)).toBe(false);
  });
});
