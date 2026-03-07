import { describe, expect, it } from 'vitest';
import { AppErrorClass } from '../base.js';
import { AGENTCORE_ERROR_IDS, AgentCoreErrors } from '../agentcore-errors.js';

describe('AGENTCORE_ERROR_IDS', () => {
  it('has the expected connection/auth error codes', () => {
    expect(AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_INVALID).toBe('AGENTCORE-001');
    expect(AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_EXPIRED).toBe('AGENTCORE-002');
    expect(AGENTCORE_ERROR_IDS.AWS_REGION_INVALID).toBe('AGENTCORE-003');
    expect(AGENTCORE_ERROR_IDS.AWS_STS_ERROR).toBe('AGENTCORE-004');
  });

  it('has the expected runtime lifecycle error codes', () => {
    expect(AGENTCORE_ERROR_IDS.RUNTIME_NOT_FOUND).toBe('AGENTCORE-100');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_CREATION_FAILED).toBe('AGENTCORE-101');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_STARTUP_TIMEOUT).toBe('AGENTCORE-102');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_DELETE_FAILED).toBe('AGENTCORE-103');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_NOT_ACTIVE).toBe('AGENTCORE-104');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_ALREADY_EXISTS).toBe('AGENTCORE-105');
    expect(AGENTCORE_ERROR_IDS.RUNTIME_UPDATE_FAILED).toBe('AGENTCORE-106');
  });

  it('has the expected endpoint lifecycle error codes', () => {
    expect(AGENTCORE_ERROR_IDS.ENDPOINT_NOT_FOUND).toBe('AGENTCORE-200');
    expect(AGENTCORE_ERROR_IDS.ENDPOINT_CREATION_FAILED).toBe('AGENTCORE-201');
  });

  it('has the expected invocation error codes', () => {
    expect(AGENTCORE_ERROR_IDS.INVOCATION_FAILED).toBe('AGENTCORE-300');
    expect(AGENTCORE_ERROR_IDS.INVOCATION_TIMEOUT).toBe('AGENTCORE-301');
    expect(AGENTCORE_ERROR_IDS.INVOCATION_THROTTLED).toBe('AGENTCORE-302');
  });

  it('has the expected ECR error codes', () => {
    expect(AGENTCORE_ERROR_IDS.ECR_AUTH_FAILED).toBe('AGENTCORE-400');
    expect(AGENTCORE_ERROR_IDS.ECR_PUSH_FAILED).toBe('AGENTCORE-401');
    expect(AGENTCORE_ERROR_IDS.ECR_IMAGE_NOT_FOUND).toBe('AGENTCORE-402');
    expect(AGENTCORE_ERROR_IDS.ECR_REPO_NOT_FOUND).toBe('AGENTCORE-403');
  });

  it('has the expected session error codes', () => {
    expect(AGENTCORE_ERROR_IDS.SESSION_CREATION_FAILED).toBe('AGENTCORE-500');
  });

  it('has the expected API error codes', () => {
    expect(AGENTCORE_ERROR_IDS.API_ERROR).toBe('AGENTCORE-700');
    expect(AGENTCORE_ERROR_IDS.INTERNAL_ERROR).toBe('AGENTCORE-701');
  });
});

describe('AgentCoreErrors', () => {
  // -- Connection / Auth errors --

  describe('AWS_CREDENTIALS_INVALID', () => {
    it('returns error with AGENTCORE-001 code and message containing the reason', () => {
      const error = AgentCoreErrors.AWS_CREDENTIALS_INVALID('invalid access key');

      expect(error.code).toBe('AGENTCORE-001');
      expect(error.status).toBe(401);
      expect(error.message).toContain('invalid access key');
    });
  });

  describe('AWS_CREDENTIALS_EXPIRED', () => {
    it('returns error with AGENTCORE-002 code', () => {
      const error = AgentCoreErrors.AWS_CREDENTIALS_EXPIRED();

      expect(error.code).toBe('AGENTCORE-002');
      expect(error.status).toBe(401);
      expect(error.message).toContain('expired');
    });
  });

  describe('AWS_REGION_INVALID', () => {
    it('returns error with AGENTCORE-003 code and message containing region', () => {
      const error = AgentCoreErrors.AWS_REGION_INVALID('xx-invalid-1');

      expect(error.code).toBe('AGENTCORE-003');
      expect(error.status).toBe(400);
      expect(error.message).toContain('xx-invalid-1');
      expect(error.details).toMatchObject({ region: 'xx-invalid-1' });
    });
  });

  describe('AWS_STS_ERROR', () => {
    it('returns error with AGENTCORE-004 code and message containing reason', () => {
      const error = AgentCoreErrors.AWS_STS_ERROR('token expired');

      expect(error.code).toBe('AGENTCORE-004');
      expect(error.status).toBe(503);
      expect(error.message).toContain('token expired');
    });
  });

  // -- Runtime lifecycle errors --

  describe('RUNTIME_NOT_FOUND', () => {
    it('returns error with AGENTCORE-100 code and message containing runtime ARN', () => {
      const error = AgentCoreErrors.RUNTIME_NOT_FOUND('arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-abc');

      expect(error.code).toBe('AGENTCORE-100');
      expect(error.status).toBe(404);
      expect(error.message).toContain('arn:aws:bedrock-agentcore');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-abc' });
    });
  });

  describe('RUNTIME_CREATION_FAILED', () => {
    it('returns error with AGENTCORE-101 code and message containing name and reason', () => {
      const error = AgentCoreErrors.RUNTIME_CREATION_FAILED('agentpane-proj-1', 'insufficient capacity');

      expect(error.code).toBe('AGENTCORE-101');
      expect(error.status).toBe(500);
      expect(error.message).toContain('agentpane-proj-1');
      expect(error.message).toContain('insufficient capacity');
      expect(error.details).toMatchObject({ name: 'agentpane-proj-1' });
    });
  });

  describe('RUNTIME_STARTUP_TIMEOUT', () => {
    it('returns error with AGENTCORE-102 code and message containing runtime ARN and timeout', () => {
      const error = AgentCoreErrors.RUNTIME_STARTUP_TIMEOUT('arn:runtime/rt-1', 300);

      expect(error.code).toBe('AGENTCORE-102');
      expect(error.status).toBe(408);
      expect(error.message).toContain('arn:runtime/rt-1');
      expect(error.message).toContain('300');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1', timeoutSeconds: 300 });
    });
  });

  describe('RUNTIME_DELETE_FAILED', () => {
    it('returns error with AGENTCORE-103 code and message containing runtime ARN', () => {
      const error = AgentCoreErrors.RUNTIME_DELETE_FAILED('arn:runtime/rt-1', 'still running');

      expect(error.code).toBe('AGENTCORE-103');
      expect(error.status).toBe(500);
      expect(error.message).toContain('arn:runtime/rt-1');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1' });
    });
  });

  describe('RUNTIME_NOT_ACTIVE', () => {
    it('returns error with AGENTCORE-104 code and message containing ARN and status', () => {
      const error = AgentCoreErrors.RUNTIME_NOT_ACTIVE('arn:runtime/rt-1', 'creating');

      expect(error.code).toBe('AGENTCORE-104');
      expect(error.status).toBe(400);
      expect(error.message).toContain('arn:runtime/rt-1');
      expect(error.message).toContain('creating');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1', currentStatus: 'creating' });
    });
  });

  describe('RUNTIME_ALREADY_EXISTS', () => {
    it('returns error with AGENTCORE-105 code', () => {
      const error = AgentCoreErrors.RUNTIME_ALREADY_EXISTS('proj-123');

      expect(error.code).toBe('AGENTCORE-105');
      expect(error.status).toBe(409);
      expect(error.details).toMatchObject({ projectId: 'proj-123' });
    });
  });

  describe('RUNTIME_UPDATE_FAILED', () => {
    it('returns error with AGENTCORE-106 code', () => {
      const error = AgentCoreErrors.RUNTIME_UPDATE_FAILED('arn:runtime/rt-1', 'validation error');

      expect(error.code).toBe('AGENTCORE-106');
      expect(error.status).toBe(500);
      expect(error.message).toContain('arn:runtime/rt-1');
      expect(error.message).toContain('validation error');
    });
  });

  // -- Endpoint lifecycle errors --

  describe('ENDPOINT_NOT_FOUND', () => {
    it('returns error with AGENTCORE-200 code', () => {
      const error = AgentCoreErrors.ENDPOINT_NOT_FOUND('my-endpoint');

      expect(error.code).toBe('AGENTCORE-200');
      expect(error.status).toBe(404);
      expect(error.message).toContain('my-endpoint');
      expect(error.details).toMatchObject({ endpointName: 'my-endpoint' });
    });
  });

  describe('ENDPOINT_CREATION_FAILED', () => {
    it('returns error with AGENTCORE-201 code', () => {
      const error = AgentCoreErrors.ENDPOINT_CREATION_FAILED('arn:runtime/rt-1', 'quota exceeded');

      expect(error.code).toBe('AGENTCORE-201');
      expect(error.status).toBe(500);
      expect(error.message).toContain('arn:runtime/rt-1');
      expect(error.message).toContain('quota exceeded');
    });
  });

  // -- Invocation errors --

  describe('INVOCATION_FAILED', () => {
    it('returns error with AGENTCORE-300 code and message containing reason', () => {
      const error = AgentCoreErrors.INVOCATION_FAILED('arn:runtime/rt-1', 'exec ls: exit code 1');

      expect(error.code).toBe('AGENTCORE-300');
      expect(error.status).toBe(500);
      expect(error.message).toContain('exit code 1');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1' });
    });
  });

  describe('INVOCATION_TIMEOUT', () => {
    it('returns error with AGENTCORE-301 code and message containing timeout', () => {
      const error = AgentCoreErrors.INVOCATION_TIMEOUT('arn:runtime/rt-1', 30000);

      expect(error.code).toBe('AGENTCORE-301');
      expect(error.status).toBe(408);
      expect(error.message).toContain('30000');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1', timeoutMs: 30000 });
    });
  });

  describe('INVOCATION_THROTTLED', () => {
    it('returns error with AGENTCORE-302 code', () => {
      const error = AgentCoreErrors.INVOCATION_THROTTLED('arn:runtime/rt-1');

      expect(error.code).toBe('AGENTCORE-302');
      expect(error.status).toBe(429);
      expect(error.message).toContain('throttled');
      expect(error.details).toMatchObject({ runtimeArn: 'arn:runtime/rt-1' });
    });
  });

  // -- ECR errors --

  describe('ECR_AUTH_FAILED', () => {
    it('returns error with AGENTCORE-400 code', () => {
      const error = AgentCoreErrors.ECR_AUTH_FAILED('token expired');

      expect(error.code).toBe('AGENTCORE-400');
      expect(error.status).toBe(401);
      expect(error.message).toContain('token expired');
    });
  });

  describe('ECR_PUSH_FAILED', () => {
    it('returns error with AGENTCORE-401 code', () => {
      const error = AgentCoreErrors.ECR_PUSH_FAILED('my-image:latest', 'access denied');

      expect(error.code).toBe('AGENTCORE-401');
      expect(error.status).toBe(500);
      expect(error.message).toContain('my-image:latest');
      expect(error.message).toContain('access denied');
      expect(error.details).toMatchObject({ image: 'my-image:latest' });
    });
  });

  describe('ECR_IMAGE_NOT_FOUND', () => {
    it('returns error with AGENTCORE-402 code', () => {
      const error = AgentCoreErrors.ECR_IMAGE_NOT_FOUND('node:22-slim');

      expect(error.code).toBe('AGENTCORE-402');
      expect(error.status).toBe(404);
      expect(error.message).toContain('node:22-slim');
      expect(error.details).toMatchObject({ image: 'node:22-slim' });
    });
  });

  describe('ECR_REPO_NOT_FOUND', () => {
    it('returns error with AGENTCORE-403 code', () => {
      const error = AgentCoreErrors.ECR_REPO_NOT_FOUND('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo');

      expect(error.code).toBe('AGENTCORE-403');
      expect(error.status).toBe(404);
      expect(error.message).toContain('my-repo');
      expect(error.details).toMatchObject({ repoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo' });
    });
  });

  // -- Session errors --

  describe('SESSION_CREATION_FAILED', () => {
    it('returns error with AGENTCORE-500 code', () => {
      const error = AgentCoreErrors.SESSION_CREATION_FAILED('timeout');

      expect(error.code).toBe('AGENTCORE-500');
      expect(error.status).toBe(500);
      expect(error.message).toContain('timeout');
    });
  });

  // -- API errors --

  describe('API_ERROR', () => {
    it('returns error with AGENTCORE-700 code and message containing status code and message', () => {
      const error = AgentCoreErrors.API_ERROR(502, 'Bad Gateway');

      expect(error.code).toBe('AGENTCORE-700');
      expect(error.status).toBe(502);
      expect(error.message).toContain('502');
      expect(error.message).toContain('Bad Gateway');
    });
  });

  describe('INTERNAL_ERROR', () => {
    it('returns error with AGENTCORE-701 code and the provided message', () => {
      const error = AgentCoreErrors.INTERNAL_ERROR('unexpected state');

      expect(error.code).toBe('AGENTCORE-701');
      expect(error.status).toBe(500);
      expect(error.message).toBe('unexpected state');
    });
  });

  // -- Structural guarantees --

  it('every factory returns an AppErrorClass instance (extends Error)', () => {
    const samples = [
      AgentCoreErrors.AWS_CREDENTIALS_INVALID('reason'),
      AgentCoreErrors.AWS_CREDENTIALS_EXPIRED(),
      AgentCoreErrors.AWS_REGION_INVALID('us-invalid-1'),
      AgentCoreErrors.AWS_STS_ERROR('reason'),
      AgentCoreErrors.RUNTIME_NOT_FOUND('arn'),
      AgentCoreErrors.RUNTIME_CREATION_FAILED('name', 'reason'),
      AgentCoreErrors.RUNTIME_STARTUP_TIMEOUT('arn', 30),
      AgentCoreErrors.RUNTIME_DELETE_FAILED('arn', 'reason'),
      AgentCoreErrors.RUNTIME_NOT_ACTIVE('arn', 'creating'),
      AgentCoreErrors.RUNTIME_ALREADY_EXISTS('pid'),
      AgentCoreErrors.RUNTIME_UPDATE_FAILED('arn', 'reason'),
      AgentCoreErrors.ENDPOINT_NOT_FOUND('ep'),
      AgentCoreErrors.ENDPOINT_CREATION_FAILED('arn', 'reason'),
      AgentCoreErrors.INVOCATION_FAILED('arn', 'reason'),
      AgentCoreErrors.INVOCATION_TIMEOUT('arn', 5000),
      AgentCoreErrors.INVOCATION_THROTTLED('arn'),
      AgentCoreErrors.ECR_AUTH_FAILED('reason'),
      AgentCoreErrors.ECR_PUSH_FAILED('img', 'reason'),
      AgentCoreErrors.ECR_IMAGE_NOT_FOUND('img'),
      AgentCoreErrors.ECR_REPO_NOT_FOUND('uri'),
      AgentCoreErrors.SESSION_CREATION_FAILED('reason'),
      AgentCoreErrors.API_ERROR(500, 'msg'),
      AgentCoreErrors.INTERNAL_ERROR('msg'),
    ];

    for (const error of samples) {
      expect(error).toHaveProperty('code');
      expect(error).toHaveProperty('message');
      expect(error).toHaveProperty('status');
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
      expect(typeof error.status).toBe('number');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppErrorClass);
    }
  });

  it('every error code uses the corresponding AGENTCORE_ERROR_IDS value', () => {
    const errorIdKeys = Object.keys(AGENTCORE_ERROR_IDS) as Array<keyof typeof AGENTCORE_ERROR_IDS>;
    const agentCoreErrorKeys = Object.keys(AgentCoreErrors) as Array<keyof typeof AgentCoreErrors>;

    // Verify same keys exist in both objects
    expect(errorIdKeys.sort()).toEqual(agentCoreErrorKeys.sort());
  });

  it('details include errorName for debugging', () => {
    const error = AgentCoreErrors.AWS_CREDENTIALS_INVALID('test');
    expect(error.details).toHaveProperty('errorName', 'AGENTCORE_AWS_CREDENTIALS_INVALID');
  });
});
