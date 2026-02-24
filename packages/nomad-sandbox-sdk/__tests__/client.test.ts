import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NomadSandboxClient } from '../src/client.js';
import { NOMAD_JOB_PREFIX } from '../src/constants.js';
import { NotFoundError } from '../src/errors.js';
import type { NomadJob, NomadJobListStub, NomadJobRegisterResponse } from '../src/types/job.js';

// ----------------------------------------------------------------
// Mock all operation modules
// ----------------------------------------------------------------
vi.mock('../src/operations/jobs.js', () => ({
  registerJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  stopJob: vi.fn(),
}));

vi.mock('../src/operations/allocations.js', () => ({
  getJobAllocations: vi.fn(),
  getAllocation: vi.fn(),
  getAllocationStats: vi.fn(),
}));

vi.mock('../src/operations/exec.js', () => ({
  execInAllocation: vi.fn(),
  execStreamInAllocation: vi.fn(),
}));

vi.mock('../src/operations/lifecycle.js', () => ({
  waitForRunning: vi.fn(),
}));

vi.mock('../src/operations/watch.js', () => ({
  watchJob: vi.fn(),
}));

import { execInAllocation, execStreamInAllocation } from '../src/operations/exec.js';
// Import mocked functions after vi.mock
import { getJob, listJobs, registerJob, stopJob } from '../src/operations/jobs.js';
import { waitForRunning } from '../src/operations/lifecycle.js';

const mockedRegisterJob = vi.mocked(registerJob);
const mockedGetJob = vi.mocked(getJob);
const mockedListJobs = vi.mocked(listJobs);
const mockedStopJob = vi.mocked(stopJob);
const mockedExecInAllocation = vi.mocked(execInAllocation);
const mockedExecStreamInAllocation = vi.mocked(execStreamInAllocation);
const mockedWaitForRunning = vi.mocked(waitForRunning);

describe('NomadSandboxClient', () => {
  let client: NomadSandboxClient;

  beforeEach(() => {
    client = new NomadSandboxClient({ address: 'http://localhost:4646' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // registerJob
  // ----------------------------------------------------------------
  describe('registerJob()', () => {
    it('delegates to registerJob operation', async () => {
      const mockResponse: NomadJobRegisterResponse = {
        EvalID: 'eval-123',
        EvalCreateIndex: 1,
        JobModifyIndex: 2,
      };
      mockedRegisterJob.mockResolvedValueOnce(mockResponse);

      const jobSpec = { ID: 'test', Name: 'test', TaskGroups: [] } as NomadJob;
      const result = await client.registerJob(jobSpec);

      expect(mockedRegisterJob).toHaveBeenCalledOnce();
      expect(mockedRegisterJob).toHaveBeenCalledWith(expect.anything(), jobSpec);
      expect(result).toEqual(mockResponse);
    });
  });

  // ----------------------------------------------------------------
  // getJob
  // ----------------------------------------------------------------
  describe('getJob()', () => {
    it('returns job when found', async () => {
      const mockJob = { ID: 'test', Name: 'test', TaskGroups: [] } as NomadJob;
      mockedGetJob.mockResolvedValueOnce(mockJob);

      const result = await client.getJob('test');
      expect(result).toEqual(mockJob);
    });

    it('returns null on 404', async () => {
      const notFoundError = new NotFoundError('job', 'missing-job');
      mockedGetJob.mockRejectedValueOnce(notFoundError);

      const result = await client.getJob('missing-job');
      expect(result).toBeNull();
    });

    it('throws on other errors', async () => {
      const serverError = new Error('Internal server error');
      mockedGetJob.mockRejectedValueOnce(serverError);

      await expect(client.getJob('test')).rejects.toThrow('Internal server error');
    });
  });

  // ----------------------------------------------------------------
  // listJobs
  // ----------------------------------------------------------------
  describe('listJobs()', () => {
    it('uses NOMAD_JOB_PREFIX by default', async () => {
      mockedListJobs.mockResolvedValueOnce([]);

      await client.listJobs();

      expect(mockedListJobs).toHaveBeenCalledWith(expect.anything(), NOMAD_JOB_PREFIX);
    });

    it('passes custom prefix', async () => {
      mockedListJobs.mockResolvedValueOnce([]);

      await client.listJobs('custom-prefix-');

      expect(mockedListJobs).toHaveBeenCalledWith(expect.anything(), 'custom-prefix-');
    });

    it('returns job stubs', async () => {
      const stubs: NomadJobListStub[] = [
        {
          ID: 'agentpane-sandbox-1',
          Name: 'agentpane-sandbox-1',
          Namespace: 'default',
          Type: 'service',
          Status: 'running',
          StatusDescription: '',
          CreateIndex: 1,
          ModifyIndex: 2,
          JobModifyIndex: 3,
        },
      ];
      mockedListJobs.mockResolvedValueOnce(stubs);

      const result = await client.listJobs();
      expect(result).toEqual(stubs);
    });
  });

  // ----------------------------------------------------------------
  // stopJob
  // ----------------------------------------------------------------
  describe('stopJob()', () => {
    it('delegates correctly', async () => {
      mockedStopJob.mockResolvedValueOnce({
        EvalID: 'eval-1',
      } as any);

      await client.stopJob('test-job', true);

      expect(mockedStopJob).toHaveBeenCalledWith(expect.anything(), 'test-job', true);
    });
  });

  // ----------------------------------------------------------------
  // exec
  // ----------------------------------------------------------------
  describe('exec()', () => {
    it('delegates to execInAllocation', async () => {
      const mockResult = { exitCode: 0, stdout: 'hello', stderr: '' };
      mockedExecInAllocation.mockResolvedValueOnce(mockResult);

      const options = {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'hello'],
      };
      const result = await client.exec(options);

      expect(mockedExecInAllocation).toHaveBeenCalledWith(expect.anything(), options);
      expect(result).toEqual(mockResult);
    });
  });

  // ----------------------------------------------------------------
  // execStream
  // ----------------------------------------------------------------
  describe('execStream()', () => {
    it('delegates to execStreamInAllocation', () => {
      const mockStreamResult = {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        stdin: new WritableStream(),
        wait: vi.fn(),
        kill: vi.fn(),
      };
      mockedExecStreamInAllocation.mockReturnValueOnce(mockStreamResult);

      const options = {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['bash'],
      };
      const result = client.execStream(options);

      expect(mockedExecStreamInAllocation).toHaveBeenCalledWith(expect.anything(), options);
      expect(result).toBe(mockStreamResult);
    });
  });

  // ----------------------------------------------------------------
  // waitForRunning
  // ----------------------------------------------------------------
  describe('waitForRunning()', () => {
    it('delegates correctly', async () => {
      const mockAlloc = {
        ID: 'alloc-1',
        ClientStatus: 'running',
      } as any;
      mockedWaitForRunning.mockResolvedValueOnce(mockAlloc);

      const result = await client.waitForRunning('job-1', 30_000);

      expect(mockedWaitForRunning).toHaveBeenCalledWith(expect.anything(), 'job-1', 30_000);
      expect(result).toEqual(mockAlloc);
    });
  });

  // ----------------------------------------------------------------
  // listNamespaces
  // ----------------------------------------------------------------
  describe('listNamespaces()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('returns namespaces from the API', async () => {
      const mockNamespaces = [
        { Name: 'default', Description: '' },
        { Name: 'production', Description: 'prod' },
      ];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockNamespaces), { status: 200 })
      );

      const result = await client.listNamespaces();
      expect(result).toEqual(mockNamespaces);
    });
  });

  // ----------------------------------------------------------------
  // listDatacenters
  // ----------------------------------------------------------------
  describe('listDatacenters()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('returns datacenters from the API', async () => {
      const mockDatacenters = ['dc1', 'dc2'];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockDatacenters), { status: 200 })
      );

      const result = await client.listDatacenters();
      expect(result).toEqual(mockDatacenters);
    });
  });

  // ----------------------------------------------------------------
  // healthCheck
  // ----------------------------------------------------------------
  describe('healthCheck()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // healthCheck uses the real http client internally, so we need to mock fetch
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('returns healthy:true with version, leader, datacenter, namespace', async () => {
      // First call: /v1/agent/self
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              Datacenter: 'dc1',
              Region: 'global',
              Version: '1.7.3',
            },
            stats: { nomad: { leader_addr: '10.0.0.1:4647' } },
          }),
          { status: 200 }
        )
      );

      // Second call: /v1/status/leader
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify('10.0.0.1:4647'), { status: 200 })
      );

      // Third call: /v1/namespaces
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { Name: 'default', Description: 'Default namespace' },
            { Name: 'engineering', Description: 'Engineering' },
          ]),
          { status: 200 }
        )
      );

      const result = await client.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.version).toBe('1.7.3');
      expect(result.leader).toBe('10.0.0.1:4647');
      expect(result.datacenter).toBe('dc1');
      expect(result.namespaceExists).toBe(true);
    });

    it('handles Version as string', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { Datacenter: 'dc1', Version: '1.8.0' },
          }),
          { status: 200 }
        )
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify('10.0.0.1:4647'), { status: 200 })
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ Name: 'default', Description: '' }]), { status: 200 })
      );

      const result = await client.healthCheck();
      expect(result.version).toBe('1.8.0');
    });

    it('handles Version as object {Version: "1.11.1"} (newer Nomad)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              Datacenter: 'dc1',
              Version: { Version: '1.11.1', BuildDate: '2024-01-01' },
            },
          }),
          { status: 200 }
        )
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify('10.0.0.1:4647'), { status: 200 })
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ Name: 'default', Description: '' }]), { status: 200 })
      );

      const result = await client.healthCheck();
      expect(result.version).toBe('1.11.1');
    });

    it('returns healthy:false with error message on connection failure', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const result = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.leader).toBeNull();
      expect(result.version).toBeNull();
      expect(result.datacenter).toBeNull();
      expect(result.namespaceExists).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('connect');
    });

    it('namespace check fallback for OSS Nomad (default namespace)', async () => {
      // Agent self succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { Datacenter: 'dc1', Version: '1.7.0' },
          }),
          { status: 200 }
        )
      );
      // Leader check succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify('10.0.0.1:4647'), { status: 200 })
      );
      // Namespace list fails (OSS Nomad doesn't support namespaces endpoint)
      mockFetch.mockResolvedValueOnce(
        new Response('Nomad Enterprise only', { status: 501, statusText: 'Not Implemented' })
      );

      // client is using default namespace
      const defaultClient = new NomadSandboxClient({ address: 'http://localhost:4646' });
      const result = await defaultClient.healthCheck();

      expect(result.healthy).toBe(true);
      // OSS fallback: namespaceExists = configuredNamespace === 'default'
      expect(result.namespaceExists).toBe(true);
    });

    it('namespace check fallback returns false for non-default namespace on OSS', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { Datacenter: 'dc1', Version: '1.7.0' },
          }),
          { status: 200 }
        )
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify('10.0.0.1:4647'), { status: 200 })
      );
      // Namespace list fails
      mockFetch.mockResolvedValueOnce(
        new Response('Nomad Enterprise only', { status: 501, statusText: 'Not Implemented' })
      );

      // Client configured with non-default namespace
      const nsClient = new NomadSandboxClient({
        address: 'http://localhost:4646',
        namespace: 'engineering',
      });
      const result = await nsClient.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.namespaceExists).toBe(false);
    });

    it('returns healthy:false when leader is empty string', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { Datacenter: 'dc1', Version: '1.7.0' },
          }),
          { status: 200 }
        )
      );
      // Empty leader string
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(''), { status: 200 }));
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ Name: 'default', Description: '' }]), { status: 200 })
      );

      const result = await client.healthCheck();
      // leader is "" which is falsy, so !!leader = false
      expect(result.healthy).toBe(false);
      expect(result.leader).toBeNull();
    });
  });
});
