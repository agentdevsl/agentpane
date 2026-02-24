import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllocation,
  getAllocationStats,
  getJobAllocations,
} from '../src/operations/allocations.js';

const createMockHttp = () => ({
  request: vi.fn(),
  blockingQuery: vi.fn(),
  wsBaseUrl: 'ws://127.0.0.1:4646',
  configuredNamespace: 'default',
  configuredToken: undefined,
});

describe('allocations operations', () => {
  let http: ReturnType<typeof createMockHttp>;

  beforeEach(() => {
    http = createMockHttp();
    vi.clearAllMocks();
  });

  describe('getJobAllocations', () => {
    it('calls GET /v1/job/:jobId/allocations with the correct jobId', async () => {
      const mockAllocations = [
        {
          ID: 'alloc-1',
          EvalID: 'eval-1',
          Name: 'test-job.main[0]',
          Namespace: 'default',
          NodeID: 'node-1',
          JobID: 'test-job',
          TaskGroup: 'main',
          ClientStatus: 'running',
          DesiredStatus: 'run',
          CreateIndex: 100,
          ModifyIndex: 105,
          CreateTime: Date.now(),
          ModifyTime: Date.now(),
        },
      ];

      http.request.mockResolvedValue(mockAllocations);

      const result = await getJobAllocations(http as any, 'test-job');

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('GET', '/v1/job/test-job/allocations');
      expect(result).toEqual(mockAllocations);
    });

    it('URL-encodes the jobId', async () => {
      http.request.mockResolvedValue([]);

      await getJobAllocations(http as any, 'my/special job');

      expect(http.request).toHaveBeenCalledWith('GET', '/v1/job/my%2Fspecial%20job/allocations');
    });

    it('returns an empty array when no allocations exist', async () => {
      http.request.mockResolvedValue([]);

      const result = await getJobAllocations(http as any, 'empty-job');

      expect(result).toEqual([]);
    });
  });

  describe('getAllocation', () => {
    it('calls GET /v1/allocation/:allocId with the correct allocId', async () => {
      const mockAllocation = {
        ID: 'alloc-abc-123',
        EvalID: 'eval-1',
        Name: 'test-job.main[0]',
        Namespace: 'default',
        NodeID: 'node-1',
        JobID: 'test-job',
        TaskGroup: 'main',
        ClientStatus: 'running',
        DesiredStatus: 'run',
        CreateIndex: 100,
        ModifyIndex: 105,
        CreateTime: Date.now(),
        ModifyTime: Date.now(),
      };

      http.request.mockResolvedValue(mockAllocation);

      const result = await getAllocation(http as any, 'alloc-abc-123');

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('GET', '/v1/allocation/alloc-abc-123');
      expect(result).toEqual(mockAllocation);
    });

    it('URL-encodes the allocId', async () => {
      http.request.mockResolvedValue({});

      await getAllocation(http as any, 'alloc/with spaces');

      expect(http.request).toHaveBeenCalledWith('GET', '/v1/allocation/alloc%2Fwith%20spaces');
    });
  });

  describe('getAllocationStats', () => {
    it('calls GET /v1/client/allocation/:allocId/stats with the correct allocId', async () => {
      const mockStats = {
        ResourceUsage: {
          CpuStats: {
            Percent: 25.5,
            TotalTicks: 1000,
          },
          MemoryStats: {
            RSS: 104857600,
            Usage: 209715200,
          },
        },
        Tasks: {
          main: {
            ResourceUsage: {
              CpuStats: { Percent: 25.5 },
              MemoryStats: { RSS: 104857600 },
            },
          },
        },
        Timestamp: Date.now(),
      };

      http.request.mockResolvedValue(mockStats);

      const result = await getAllocationStats(http as any, 'alloc-xyz-789');

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('GET', '/v1/client/allocation/alloc-xyz-789/stats');
      expect(result).toEqual(mockStats);
    });

    it('URL-encodes the allocId', async () => {
      http.request.mockResolvedValue({ Timestamp: 0 });

      await getAllocationStats(http as any, 'alloc/special');

      expect(http.request).toHaveBeenCalledWith(
        'GET',
        '/v1/client/allocation/alloc%2Fspecial/stats'
      );
    });
  });
});
