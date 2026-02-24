import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJob, listJobs, registerJob, stopJob } from '../src/operations/jobs.js';
import type { NomadJob } from '../src/types/job.js';

const createMockHttp = () => ({
  request: vi.fn(),
  blockingQuery: vi.fn(),
  wsBaseUrl: 'ws://127.0.0.1:4646',
  configuredNamespace: 'default',
  configuredToken: undefined,
});

const stubJobSpec = (overrides?: Partial<NomadJob>): NomadJob => ({
  ID: 'test-job',
  Name: 'test-job',
  Type: 'service',
  Datacenters: ['dc1'],
  TaskGroups: [
    {
      Name: 'main',
      Count: 1,
      Tasks: [
        {
          Name: 'app',
          Driver: 'docker',
          Config: { image: 'nginx:latest' },
          Resources: { CPU: 500, MemoryMB: 256 },
        },
      ],
    },
  ],
  ...overrides,
});

describe('jobs operations', () => {
  let http: ReturnType<typeof createMockHttp>;

  beforeEach(() => {
    http = createMockHttp();
    vi.clearAllMocks();
  });

  describe('registerJob', () => {
    it('sends POST /v1/jobs with { Job: spec }', async () => {
      const mockResponse = {
        EvalID: 'eval-123',
        EvalCreateIndex: 50,
        JobModifyIndex: 51,
      };

      http.request.mockResolvedValue(mockResponse);

      const spec = stubJobSpec();
      const result = await registerJob(http as any, spec);

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('POST', '/v1/jobs', {
        body: { Job: spec },
      });
      expect(result).toEqual(mockResponse);
    });

    it('wraps the full job spec inside { Job: ... }', async () => {
      http.request.mockResolvedValue({ EvalID: 'eval-456' });

      const spec = stubJobSpec({ ID: 'custom-job', Name: 'Custom Job' });
      await registerJob(http as any, spec);

      const callArgs = http.request.mock.calls[0];
      const body = callArgs[2]?.body;

      expect(body).toHaveProperty('Job');
      expect(body.Job.ID).toBe('custom-job');
      expect(body.Job.Name).toBe('Custom Job');
      expect(body.Job.TaskGroups).toHaveLength(1);
    });
  });

  describe('getJob', () => {
    it('sends GET /v1/job/:jobId', async () => {
      const mockJob = stubJobSpec({ Status: 'running' });
      http.request.mockResolvedValue(mockJob);

      const result = await getJob(http as any, 'test-job');

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('GET', '/v1/job/test-job');
      expect(result).toEqual(mockJob);
    });

    it('URL-encodes the jobId', async () => {
      http.request.mockResolvedValue(stubJobSpec());

      await getJob(http as any, 'my/special job');

      expect(http.request).toHaveBeenCalledWith('GET', '/v1/job/my%2Fspecial%20job');
    });
  });

  describe('listJobs', () => {
    it('sends GET /v1/jobs without prefix when none provided', async () => {
      const mockJobs = [
        {
          ID: 'job-1',
          Name: 'Job One',
          Namespace: 'default',
          Type: 'service',
          Status: 'running',
          StatusDescription: '',
          CreateIndex: 10,
          ModifyIndex: 15,
          JobModifyIndex: 14,
        },
        {
          ID: 'job-2',
          Name: 'Job Two',
          Namespace: 'default',
          Type: 'batch',
          Status: 'dead',
          StatusDescription: '',
          CreateIndex: 20,
          ModifyIndex: 25,
          JobModifyIndex: 24,
        },
      ];

      http.request.mockResolvedValue(mockJobs);

      const result = await listJobs(http as any);

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('GET', '/v1/jobs', {
        query: {},
      });
      expect(result).toEqual(mockJobs);
      expect(result).toHaveLength(2);
    });

    it('sends GET /v1/jobs with prefix query param', async () => {
      http.request.mockResolvedValue([]);

      await listJobs(http as any, 'agent-sandbox-');

      expect(http.request).toHaveBeenCalledWith('GET', '/v1/jobs', {
        query: { prefix: 'agent-sandbox-' },
      });
    });

    it('does not include prefix in query when prefix is undefined', async () => {
      http.request.mockResolvedValue([]);

      await listJobs(http as any, undefined);

      const callArgs = http.request.mock.calls[0];
      const queryParam = callArgs[2]?.query;

      expect(queryParam).toEqual({});
      expect(queryParam).not.toHaveProperty('prefix');
    });
  });

  describe('stopJob', () => {
    it('sends DELETE /v1/job/:jobId without purge by default', async () => {
      const mockResponse = {
        EvalID: 'eval-789',
        EvalCreateIndex: 100,
        JobModifyIndex: 101,
      };

      http.request.mockResolvedValue(mockResponse);

      const result = await stopJob(http as any, 'test-job');

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('DELETE', '/v1/job/test-job', { query: {} });
      expect(result).toEqual(mockResponse);
    });

    it('sends DELETE /v1/job/:jobId with purge=true when purge is true', async () => {
      http.request.mockResolvedValue({ EvalID: 'eval-purge' });

      await stopJob(http as any, 'test-job', true);

      expect(http.request).toHaveBeenCalledWith('DELETE', '/v1/job/test-job', {
        query: { purge: 'true' },
      });
    });

    it('does not include purge in query when purge is false', async () => {
      http.request.mockResolvedValue({ EvalID: 'eval-no-purge' });

      await stopJob(http as any, 'test-job', false);

      const callArgs = http.request.mock.calls[0];
      const queryParam = callArgs[2]?.query;

      expect(queryParam).toEqual({});
      expect(queryParam).not.toHaveProperty('purge');
    });

    it('URL-encodes the jobId', async () => {
      http.request.mockResolvedValue({ EvalID: 'eval-enc' });

      await stopJob(http as any, 'my/special job');

      expect(http.request).toHaveBeenCalledWith('DELETE', '/v1/job/my%2Fspecial%20job', {
        query: {},
      });
    });
  });
});
