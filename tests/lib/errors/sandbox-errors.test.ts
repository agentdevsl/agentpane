/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { SandboxErrors } from '@/lib/errors/sandbox-errors';

// =============================================================================
// Container Errors
// =============================================================================

describe('SandboxErrors - Container', () => {
  it('CONTAINER_NOT_FOUND has code and status 404', () => {
    expect(SandboxErrors.CONTAINER_NOT_FOUND.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
    expect(SandboxErrors.CONTAINER_NOT_FOUND.status).toBe(404);
  });

  it('CONTAINER_ALREADY_EXISTS includes codespaceId', () => {
    const error = SandboxErrors.CONTAINER_ALREADY_EXISTS('proj-1');

    expect(error.code).toBe('SANDBOX_CONTAINER_ALREADY_EXISTS');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ codespaceId: 'proj-1' });
  });

  it('CONTAINER_CREATION_FAILED includes message in text', () => {
    const error = SandboxErrors.CONTAINER_CREATION_FAILED('out of disk space');

    expect(error.code).toBe('SANDBOX_CONTAINER_CREATION_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('out of disk space');
  });

  it('CONTAINER_START_FAILED includes message in text', () => {
    const error = SandboxErrors.CONTAINER_START_FAILED('port conflict');

    expect(error.code).toBe('SANDBOX_CONTAINER_START_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('port conflict');
  });

  it('CONTAINER_STOP_FAILED includes message in text', () => {
    const error = SandboxErrors.CONTAINER_STOP_FAILED('timeout');

    expect(error.code).toBe('SANDBOX_CONTAINER_STOP_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('timeout');
  });

  it('CONTAINER_NOT_RUNNING has status 400', () => {
    expect(SandboxErrors.CONTAINER_NOT_RUNNING.code).toBe('SANDBOX_CONTAINER_NOT_RUNNING');
    expect(SandboxErrors.CONTAINER_NOT_RUNNING.status).toBe(400);
  });
});

// =============================================================================
// Image Errors
// =============================================================================

describe('SandboxErrors - Image', () => {
  it('IMAGE_NOT_FOUND includes image detail', () => {
    const error = SandboxErrors.IMAGE_NOT_FOUND('my-image:latest');

    expect(error.code).toBe('SANDBOX_IMAGE_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ image: 'my-image:latest' });
  });

  it('IMAGE_PULL_FAILED includes image detail', () => {
    const error = SandboxErrors.IMAGE_PULL_FAILED('my-image:v2', 'auth error');

    expect(error.code).toBe('SANDBOX_IMAGE_PULL_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ image: 'my-image:v2' });
  });
});

// =============================================================================
// Execution Errors
// =============================================================================

describe('SandboxErrors - Execution', () => {
  it('EXEC_FAILED includes command detail', () => {
    const error = SandboxErrors.EXEC_FAILED('npm install', 'exit code 1');

    expect(error.code).toBe('SANDBOX_EXEC_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ command: 'npm install' });
  });

  it('EXEC_TIMEOUT includes command and timeoutMs', () => {
    const error = SandboxErrors.EXEC_TIMEOUT('npm test', 30000);

    expect(error.code).toBe('SANDBOX_EXEC_TIMEOUT');
    expect(error.status).toBe(408);
    expect(error.message).toContain('30000');
    expect(error.details).toEqual({ command: 'npm test', timeoutMs: 30000 });
  });
});

// =============================================================================
// Tmux Errors
// =============================================================================

describe('SandboxErrors - Tmux', () => {
  it('TMUX_SESSION_NOT_FOUND includes sessionName', () => {
    const error = SandboxErrors.TMUX_SESSION_NOT_FOUND('main');

    expect(error.code).toBe('SANDBOX_TMUX_SESSION_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ sessionName: 'main' });
  });

  it('TMUX_SESSION_ALREADY_EXISTS includes sessionName', () => {
    const error = SandboxErrors.TMUX_SESSION_ALREADY_EXISTS('agent-1');

    expect(error.code).toBe('SANDBOX_TMUX_SESSION_EXISTS');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ sessionName: 'agent-1' });
  });

  it('TMUX_CREATION_FAILED includes sessionName', () => {
    const error = SandboxErrors.TMUX_CREATION_FAILED('sess', 'tmux not installed');

    expect(error.code).toBe('SANDBOX_TMUX_CREATION_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ sessionName: 'sess' });
  });
});

// =============================================================================
// Credentials Errors
// =============================================================================

describe('SandboxErrors - Credentials', () => {
  it('CREDENTIALS_INJECTION_FAILED includes message', () => {
    const error = SandboxErrors.CREDENTIALS_INJECTION_FAILED('file write failed');

    expect(error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('file write failed');
  });

  it('CREDENTIALS_NOT_FOUND has status 401', () => {
    expect(SandboxErrors.CREDENTIALS_NOT_FOUND.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
    expect(SandboxErrors.CREDENTIALS_NOT_FOUND.status).toBe(401);
  });
});

// =============================================================================
// Provider Errors
// =============================================================================

describe('SandboxErrors - Provider', () => {
  it('PROVIDER_NOT_AVAILABLE includes provider detail', () => {
    const error = SandboxErrors.PROVIDER_NOT_AVAILABLE('kubernetes');

    expect(error.code).toBe('SANDBOX_PROVIDER_NOT_AVAILABLE');
    expect(error.status).toBe(503);
    expect(error.details).toEqual({ provider: 'kubernetes' });
  });

  it('PROVIDER_HEALTH_CHECK_FAILED includes provider detail', () => {
    const error = SandboxErrors.PROVIDER_HEALTH_CHECK_FAILED('docker', 'daemon offline');

    expect(error.code).toBe('SANDBOX_PROVIDER_HEALTH_CHECK_FAILED');
    expect(error.status).toBe(503);
    expect(error.details).toEqual({ provider: 'docker' });
  });

  it('DOCKER_NOT_RUNNING has status 503', () => {
    expect(SandboxErrors.DOCKER_NOT_RUNNING.code).toBe('SANDBOX_DOCKER_NOT_RUNNING');
    expect(SandboxErrors.DOCKER_NOT_RUNNING.status).toBe(503);
  });
});

// =============================================================================
// State Errors
// =============================================================================

describe('SandboxErrors - State', () => {
  it('INVALID_STATE_TRANSITION includes from and to details', () => {
    const error = SandboxErrors.INVALID_STATE_TRANSITION('stopped', 'removing');

    expect(error.code).toBe('SANDBOX_INVALID_STATE_TRANSITION');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ from: 'stopped', to: 'removing' });
  });

  it('SANDBOX_BUSY includes sandboxId', () => {
    const error = SandboxErrors.SANDBOX_BUSY('sb-1');

    expect(error.code).toBe('SANDBOX_BUSY');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ sandboxId: 'sb-1' });
  });
});

// =============================================================================
// Resource and Volume Errors
// =============================================================================

describe('SandboxErrors - Resource and Volume', () => {
  it('RESOURCE_LIMIT_EXCEEDED includes resource, limit, and requested', () => {
    const error = SandboxErrors.RESOURCE_LIMIT_EXCEEDED('memory', 4096, 8192);

    expect(error.code).toBe('SANDBOX_RESOURCE_LIMIT_EXCEEDED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ resource: 'memory', limit: 4096, requested: 8192 });
  });

  it('VOLUME_MOUNT_FAILED includes paths', () => {
    const error = SandboxErrors.VOLUME_MOUNT_FAILED('/host/path', '/container/path', 'no access');

    expect(error.code).toBe('SANDBOX_VOLUME_MOUNT_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ hostPath: '/host/path', containerPath: '/container/path' });
  });
});

// =============================================================================
// Agent Errors (Sandbox)
// =============================================================================

describe('SandboxErrors - Agent', () => {
  it('AGENT_ALREADY_RUNNING includes taskId', () => {
    const error = SandboxErrors.AGENT_ALREADY_RUNNING('task-1');

    expect(error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ taskId: 'task-1' });
  });

  it('AGENT_NOT_RUNNING includes taskId', () => {
    const error = SandboxErrors.AGENT_NOT_RUNNING('task-2');

    expect(error.code).toBe('SANDBOX_AGENT_NOT_RUNNING');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ taskId: 'task-2' });
  });

  it('AGENT_START_FAILED includes message', () => {
    const error = SandboxErrors.AGENT_START_FAILED('container not ready');

    expect(error.code).toBe('SANDBOX_AGENT_START_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('container not ready');
  });

  it('AGENT_STOP_FAILED includes message', () => {
    const error = SandboxErrors.AGENT_STOP_FAILED('pid not found');

    expect(error.code).toBe('SANDBOX_AGENT_STOP_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('pid not found');
  });
});

// =============================================================================
// Miscellaneous Sandbox Errors
// =============================================================================

describe('SandboxErrors - Miscellaneous', () => {
  it('PROJECT_NOT_FOUND has status 404', () => {
    expect(SandboxErrors.PROJECT_NOT_FOUND.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
    expect(SandboxErrors.PROJECT_NOT_FOUND.status).toBe(404);
  });

  it('SANDBOX_NOT_ENABLED includes codespaceId', () => {
    const error = SandboxErrors.SANDBOX_NOT_ENABLED('p-1');

    expect(error.code).toBe('SANDBOX_NOT_ENABLED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ codespaceId: 'p-1' });
  });

  it('INTERNAL_ERROR wraps message', () => {
    const error = SandboxErrors.INTERNAL_ERROR('unexpected');

    expect(error.code).toBe('SANDBOX_INTERNAL_ERROR');
    expect(error.status).toBe(500);
    expect(error.message).toBe('unexpected');
  });

  it('TASK_NOT_FOUND includes taskId', () => {
    const error = SandboxErrors.TASK_NOT_FOUND('t-1');

    expect(error.code).toBe('SANDBOX_TASK_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ taskId: 't-1' });
  });

  it('STREAMING_EXEC_NOT_SUPPORTED has status 501', () => {
    expect(SandboxErrors.STREAMING_EXEC_NOT_SUPPORTED.code).toBe(
      'SANDBOX_STREAMING_EXEC_NOT_SUPPORTED'
    );
    expect(SandboxErrors.STREAMING_EXEC_NOT_SUPPORTED.status).toBe(501);
  });

  it('API_KEY_NOT_CONFIGURED has status 401', () => {
    expect(SandboxErrors.API_KEY_NOT_CONFIGURED.code).toBe('SANDBOX_API_KEY_NOT_CONFIGURED');
    expect(SandboxErrors.API_KEY_NOT_CONFIGURED.status).toBe(401);
  });

  it('SESSION_CREATE_FAILED includes message', () => {
    const error = SandboxErrors.SESSION_CREATE_FAILED('db error');
    expect(error.code).toBe('SANDBOX_SESSION_CREATE_FAILED');
    expect(error.status).toBe(500);
  });

  it('STREAM_CREATE_FAILED includes message', () => {
    const error = SandboxErrors.STREAM_CREATE_FAILED('init error');
    expect(error.code).toBe('SANDBOX_STREAM_CREATE_FAILED');
    expect(error.status).toBe(500);
  });

  it('STREAM_PUBLISH_FAILED includes message', () => {
    const error = SandboxErrors.STREAM_PUBLISH_FAILED('publish error');
    expect(error.code).toBe('SANDBOX_STREAM_PUBLISH_FAILED');
    expect(error.status).toBe(500);
  });

  it('AGENT_RECORD_FAILED includes message', () => {
    const error = SandboxErrors.AGENT_RECORD_FAILED('constraint');
    expect(error.code).toBe('SANDBOX_AGENT_RECORD_FAILED');
    expect(error.status).toBe(500);
  });

  it('PLAN_NOT_FOUND includes taskId', () => {
    const error = SandboxErrors.PLAN_NOT_FOUND('t-1');
    expect(error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ taskId: 't-1' });
  });

  it('PLAN_REJECTION_FAILED includes taskId', () => {
    const error = SandboxErrors.PLAN_REJECTION_FAILED('t-2', 'db error');
    expect(error.code).toBe('SANDBOX_PLAN_REJECTION_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ taskId: 't-2' });
  });

  it('WORKTREE_CREATION_FAILED includes message', () => {
    const error = SandboxErrors.WORKTREE_CREATION_FAILED('git error');
    expect(error.code).toBe('SANDBOX_WORKTREE_CREATION_FAILED');
    expect(error.status).toBe(500);
  });

  it('WORKTREE_COMMIT_FAILED includes message', () => {
    const error = SandboxErrors.WORKTREE_COMMIT_FAILED('no changes');
    expect(error.code).toBe('SANDBOX_WORKTREE_COMMIT_FAILED');
    expect(error.status).toBe(500);
  });
});
