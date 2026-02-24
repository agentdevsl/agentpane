import { describe, expect, it } from 'vitest';
import { NOMAD_ERROR_IDS, NomadErrors } from '../nomad-errors.js';

describe('NOMAD_ERROR_IDS', () => {
  it('has the expected connection error codes', () => {
    expect(NOMAD_ERROR_IDS.CLUSTER_UNREACHABLE).toBe('NOMAD-001');
    expect(NOMAD_ERROR_IDS.CONNECTION_REFUSED).toBe('NOMAD-002');
    expect(NOMAD_ERROR_IDS.AUTH_FAILED).toBe('NOMAD-003');
    expect(NOMAD_ERROR_IDS.TLS_ERROR).toBe('NOMAD-004');
  });

  it('has the expected namespace error codes', () => {
    expect(NOMAD_ERROR_IDS.NAMESPACE_NOT_FOUND).toBe('NOMAD-100');
  });

  it('has the expected job lifecycle error codes', () => {
    expect(NOMAD_ERROR_IDS.JOB_NOT_FOUND).toBe('NOMAD-200');
    expect(NOMAD_ERROR_IDS.JOB_CREATION_FAILED).toBe('NOMAD-201');
    expect(NOMAD_ERROR_IDS.JOB_STARTUP_TIMEOUT).toBe('NOMAD-202');
    expect(NOMAD_ERROR_IDS.JOB_STOP_FAILED).toBe('NOMAD-203');
    expect(NOMAD_ERROR_IDS.JOB_NOT_RUNNING).toBe('NOMAD-204');
    expect(NOMAD_ERROR_IDS.JOB_ALREADY_EXISTS).toBe('NOMAD-205');
    expect(NOMAD_ERROR_IDS.ALLOCATION_NOT_FOUND).toBe('NOMAD-210');
    expect(NOMAD_ERROR_IDS.ALLOCATION_FAILED).toBe('NOMAD-211');
  });

  it('has the expected exec error codes', () => {
    expect(NOMAD_ERROR_IDS.EXEC_FAILED).toBe('NOMAD-300');
    expect(NOMAD_ERROR_IDS.EXEC_TIMEOUT).toBe('NOMAD-301');
    expect(NOMAD_ERROR_IDS.EXEC_CONNECTION_FAILED).toBe('NOMAD-302');
  });

  it('has the expected image error codes', () => {
    expect(NOMAD_ERROR_IDS.IMAGE_NOT_FOUND).toBe('NOMAD-400');
  });

  it('has the expected tmux error codes', () => {
    expect(NOMAD_ERROR_IDS.TMUX_SESSION_NOT_FOUND).toBe('NOMAD-500');
    expect(NOMAD_ERROR_IDS.TMUX_SESSION_ALREADY_EXISTS).toBe('NOMAD-501');
    expect(NOMAD_ERROR_IDS.TMUX_CREATION_FAILED).toBe('NOMAD-502');
  });

  it('has the expected API error codes', () => {
    expect(NOMAD_ERROR_IDS.API_ERROR).toBe('NOMAD-700');
    expect(NOMAD_ERROR_IDS.INTERNAL_ERROR).toBe('NOMAD-701');
  });
});

describe('NomadErrors', () => {
  // ── Connection errors ──────────────────────────────────────────────

  describe('CLUSTER_UNREACHABLE', () => {
    it('returns error with code NOMAD_CLUSTER_UNREACHABLE and message containing the address', () => {
      const error = NomadErrors.CLUSTER_UNREACHABLE('http://nomad.local:4646', 'connection reset');

      expect(error.code).toBe('NOMAD_CLUSTER_UNREACHABLE');
      expect(error.status).toBe(503);
      expect(error.message).toContain('http://nomad.local:4646');
      expect(error.message).toContain('connection reset');
    });
  });

  describe('CONNECTION_REFUSED', () => {
    it('returns error with code NOMAD_CONNECTION_REFUSED and message containing the address', () => {
      const error = NomadErrors.CONNECTION_REFUSED('http://127.0.0.1:4646');

      expect(error.code).toBe('NOMAD_CONNECTION_REFUSED');
      expect(error.status).toBe(503);
      expect(error.message).toContain('http://127.0.0.1:4646');
      expect(error.details).toEqual({ address: 'http://127.0.0.1:4646' });
    });
  });

  describe('AUTH_FAILED', () => {
    it('returns error with code NOMAD_AUTH_FAILED', () => {
      const error = NomadErrors.AUTH_FAILED('invalid ACL token');

      expect(error.code).toBe('NOMAD_AUTH_FAILED');
      expect(error.status).toBe(401);
      expect(error.message).toContain('invalid ACL token');
    });
  });

  // ── Namespace errors ───────────────────────────────────────────────

  describe('NAMESPACE_NOT_FOUND', () => {
    it('returns error with code NOMAD_NAMESPACE_NOT_FOUND and message containing namespace', () => {
      const error = NomadErrors.NAMESPACE_NOT_FOUND('production');

      expect(error.code).toBe('NOMAD_NAMESPACE_NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.message).toContain('production');
      expect(error.details).toEqual({ namespace: 'production' });
    });
  });

  // ── Job lifecycle errors ───────────────────────────────────────────

  describe('JOB_NOT_FOUND', () => {
    it('returns error with code NOMAD_JOB_NOT_FOUND and message containing job id', () => {
      const error = NomadErrors.JOB_NOT_FOUND('my-job');

      expect(error.code).toBe('NOMAD_JOB_NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.message).toContain('my-job');
      expect(error.details).toEqual({ jobId: 'my-job' });
    });
  });

  describe('JOB_CREATION_FAILED', () => {
    it('returns error with code NOMAD_JOB_CREATION_FAILED and message containing name and reason', () => {
      const error = NomadErrors.JOB_CREATION_FAILED('agent-sandbox-1', 'insufficient resources');

      expect(error.code).toBe('NOMAD_JOB_CREATION_FAILED');
      expect(error.status).toBe(500);
      expect(error.message).toContain('agent-sandbox-1');
      expect(error.message).toContain('insufficient resources');
      expect(error.details).toEqual({ jobName: 'agent-sandbox-1' });
    });
  });

  describe('JOB_STARTUP_TIMEOUT', () => {
    it('returns error with code NOMAD_JOB_STARTUP_TIMEOUT and message containing job id and timeout', () => {
      const error = NomadErrors.JOB_STARTUP_TIMEOUT('sandbox-job', 60);

      expect(error.code).toBe('NOMAD_JOB_STARTUP_TIMEOUT');
      expect(error.status).toBe(408);
      expect(error.message).toContain('sandbox-job');
      expect(error.message).toContain('60');
      expect(error.details).toEqual({ jobId: 'sandbox-job', timeoutSeconds: 60 });
    });
  });

  describe('JOB_STOP_FAILED', () => {
    it('returns error with code NOMAD_JOB_STOP_FAILED and message containing job id', () => {
      const error = NomadErrors.JOB_STOP_FAILED('sandbox-job', 'allocation still running');

      expect(error.code).toBe('NOMAD_JOB_STOP_FAILED');
      expect(error.status).toBe(500);
      expect(error.message).toContain('sandbox-job');
      expect(error.details).toEqual({ jobId: 'sandbox-job' });
    });
  });

  describe('JOB_NOT_RUNNING', () => {
    it('returns error with code NOMAD_JOB_NOT_RUNNING and message containing name and status', () => {
      const error = NomadErrors.JOB_NOT_RUNNING('my-job', 'dead');

      expect(error.code).toBe('NOMAD_JOB_NOT_RUNNING');
      expect(error.status).toBe(400);
      expect(error.message).toContain('my-job');
      expect(error.message).toContain('dead');
      expect(error.details).toEqual({ jobId: 'my-job', currentStatus: 'dead' });
    });
  });

  describe('JOB_ALREADY_EXISTS', () => {
    it('returns error with code NOMAD_JOB_ALREADY_EXISTS', () => {
      const error = NomadErrors.JOB_ALREADY_EXISTS('proj-123');

      expect(error.code).toBe('NOMAD_JOB_ALREADY_EXISTS');
      expect(error.status).toBe(409);
      expect(error.details).toEqual({ projectId: 'proj-123' });
    });
  });

  describe('ALLOCATION_NOT_FOUND', () => {
    it('returns error with code NOMAD_ALLOCATION_NOT_FOUND and message containing alloc id', () => {
      const error = NomadErrors.ALLOCATION_NOT_FOUND('alloc-abc');

      expect(error.code).toBe('NOMAD_ALLOCATION_NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.message).toContain('alloc-abc');
      expect(error.details).toEqual({ allocId: 'alloc-abc' });
    });
  });

  describe('ALLOCATION_FAILED', () => {
    it('returns error with code NOMAD_ALLOCATION_FAILED and message containing alloc id and reason', () => {
      const error = NomadErrors.ALLOCATION_FAILED('alloc-def', 'OOM killed');

      expect(error.code).toBe('NOMAD_ALLOCATION_FAILED');
      expect(error.status).toBe(500);
      expect(error.message).toContain('alloc-def');
      expect(error.message).toContain('OOM killed');
      expect(error.details).toEqual({ allocId: 'alloc-def' });
    });
  });

  // ── Exec errors ────────────────────────────────────────────────────

  describe('EXEC_FAILED', () => {
    it('returns error with code NOMAD_EXEC_FAILED and message containing cmd and reason', () => {
      const error = NomadErrors.EXEC_FAILED('npm install', 'exit code 1');

      expect(error.code).toBe('NOMAD_EXEC_FAILED');
      expect(error.status).toBe(500);
      expect(error.message).toContain('exit code 1');
      expect(error.details).toEqual({ command: 'npm install' });
    });
  });

  describe('EXEC_TIMEOUT', () => {
    it('returns error with code NOMAD_EXEC_TIMEOUT and message containing cmd and timeout', () => {
      const error = NomadErrors.EXEC_TIMEOUT('git clone', 30000);

      expect(error.code).toBe('NOMAD_EXEC_TIMEOUT');
      expect(error.status).toBe(408);
      expect(error.message).toContain('30000');
      expect(error.details).toEqual({ command: 'git clone', timeoutMs: 30000 });
    });
  });

  describe('EXEC_CONNECTION_FAILED', () => {
    it('returns error with code NOMAD_EXEC_CONNECTION_FAILED and message containing alloc id and reason', () => {
      const error = NomadErrors.EXEC_CONNECTION_FAILED('alloc-xyz', 'websocket closed');

      expect(error.code).toBe('NOMAD_EXEC_CONNECTION_FAILED');
      expect(error.status).toBe(503);
      expect(error.message).toContain('alloc-xyz');
      expect(error.message).toContain('websocket closed');
      expect(error.details).toEqual({ allocId: 'alloc-xyz' });
    });
  });

  // ── Image errors ───────────────────────────────────────────────────

  describe('IMAGE_NOT_FOUND', () => {
    it('returns error with code NOMAD_IMAGE_NOT_FOUND and message containing image name', () => {
      const error = NomadErrors.IMAGE_NOT_FOUND('node:22-slim');

      expect(error.code).toBe('NOMAD_IMAGE_NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.message).toContain('node:22-slim');
      expect(error.details).toEqual({ image: 'node:22-slim' });
    });
  });

  // ── tmux errors ────────────────────────────────────────────────────

  describe('TMUX_SESSION_NOT_FOUND', () => {
    it('returns error with code NOMAD_TMUX_SESSION_NOT_FOUND and message containing session name', () => {
      const error = NomadErrors.TMUX_SESSION_NOT_FOUND('agent-session-1');

      expect(error.code).toBe('NOMAD_TMUX_SESSION_NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.message).toContain('agent-session-1');
      expect(error.details).toEqual({ sessionName: 'agent-session-1' });
    });
  });

  describe('TMUX_SESSION_ALREADY_EXISTS', () => {
    it('returns error with code NOMAD_TMUX_SESSION_ALREADY_EXISTS and message containing session name', () => {
      const error = NomadErrors.TMUX_SESSION_ALREADY_EXISTS('agent-session-1');

      expect(error.code).toBe('NOMAD_TMUX_SESSION_ALREADY_EXISTS');
      expect(error.status).toBe(409);
      expect(error.message).toContain('agent-session-1');
      expect(error.details).toEqual({ sessionName: 'agent-session-1' });
    });
  });

  describe('TMUX_CREATION_FAILED', () => {
    it('returns error with code NOMAD_TMUX_CREATION_FAILED and message containing reason', () => {
      const error = NomadErrors.TMUX_CREATION_FAILED('agent-session-1', 'tmux not installed');

      expect(error.code).toBe('NOMAD_TMUX_CREATION_FAILED');
      expect(error.status).toBe(500);
      expect(error.message).toContain('tmux not installed');
      expect(error.details).toEqual({ sessionName: 'agent-session-1' });
    });
  });

  // ── API errors ─────────────────────────────────────────────────────

  describe('API_ERROR', () => {
    it('returns error with code NOMAD_API_ERROR and message containing status code and message', () => {
      const error = NomadErrors.API_ERROR(502, 'Bad Gateway');

      expect(error.code).toBe('NOMAD_API_ERROR');
      expect(error.status).toBe(502);
      expect(error.message).toContain('502');
      expect(error.message).toContain('Bad Gateway');
    });
  });

  describe('INTERNAL_ERROR', () => {
    it('returns error with code NOMAD_INTERNAL_ERROR and the provided message', () => {
      const error = NomadErrors.INTERNAL_ERROR('unexpected state');

      expect(error.code).toBe('NOMAD_INTERNAL_ERROR');
      expect(error.status).toBe(500);
      expect(error.message).toBe('unexpected state');
    });
  });

  // ── Structural guarantees ──────────────────────────────────────────

  it('every factory returns an object with code, message, and status', () => {
    const samples = [
      NomadErrors.CLUSTER_UNREACHABLE('addr', 'msg'),
      NomadErrors.CONNECTION_REFUSED('addr'),
      NomadErrors.AUTH_FAILED('msg'),
      NomadErrors.NAMESPACE_NOT_FOUND('ns'),
      NomadErrors.JOB_NOT_FOUND('id'),
      NomadErrors.JOB_CREATION_FAILED('name', 'reason'),
      NomadErrors.JOB_STARTUP_TIMEOUT('id', 30),
      NomadErrors.JOB_STOP_FAILED('id', 'reason'),
      NomadErrors.JOB_NOT_RUNNING('id', 'dead'),
      NomadErrors.JOB_ALREADY_EXISTS('pid'),
      NomadErrors.ALLOCATION_NOT_FOUND('alloc'),
      NomadErrors.ALLOCATION_FAILED('alloc', 'msg'),
      NomadErrors.EXEC_FAILED('cmd', 'reason'),
      NomadErrors.EXEC_TIMEOUT('cmd', 5000),
      NomadErrors.EXEC_CONNECTION_FAILED('alloc', 'msg'),
      NomadErrors.IMAGE_NOT_FOUND('img'),
      NomadErrors.TMUX_SESSION_NOT_FOUND('sess'),
      NomadErrors.TMUX_SESSION_ALREADY_EXISTS('sess'),
      NomadErrors.TMUX_CREATION_FAILED('sess', 'msg'),
      NomadErrors.API_ERROR(500, 'msg'),
      NomadErrors.INTERNAL_ERROR('msg'),
    ];

    for (const error of samples) {
      expect(error).toHaveProperty('code');
      expect(error).toHaveProperty('message');
      expect(error).toHaveProperty('status');
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
      expect(typeof error.status).toBe('number');
    }
  });
});
