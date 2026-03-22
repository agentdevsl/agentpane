// @ts-nocheck — test assertions use array indexing that TS flags as possibly undefined
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryErrors } from '../../../lib/errors/memory-errors.js';
import { err, ok } from '../../../lib/utils/result.js';
import type {
  MemoryAdminServiceInterface,
  MemoryCaptureServiceInterface,
  MemoryQueryServiceInterface,
} from '../memory.service.js';
import { MemoryService } from '../memory.service.js';
import type { HonchoSessionRef, MemoryConclusion, MemoryContext, SearchResult } from '../types.js';
import { EMPTY_CONTEXT } from '../types.js';

// ---------------------------------------------------------------------------
// Mock MemoryClientService — vi.mock at module level
// ---------------------------------------------------------------------------

const mockClientIsAvailable = vi.fn(() => false);
const mockClientPing = vi.fn();
const mockClientDeleteWorkspace = vi.fn();
const mockClientInitialize = vi.fn();

vi.mock('../memory-client.service.js', () => {
  class MockMemoryClientService {
    isAvailable = mockClientIsAvailable;
    ping = mockClientPing;
    deleteWorkspace = mockClientDeleteWorkspace;
    initialize = mockClientInitialize;
  }
  return { MemoryClientService: MockMemoryClientService };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSettingsService = {
  get: vi.fn(),
  getValue: vi.fn(),
  set: vi.fn(),
} as unknown;

function createQueryService(
  overrides: Partial<MemoryQueryServiceInterface> = {}
): MemoryQueryServiceInterface {
  return {
    assembleContext: vi.fn().mockResolvedValue(
      ok({
        text: 'memory context',
        tokenCount: 10,
        sources: { conclusions: 3, platformConclusions: 1 },
      } satisfies MemoryContext)
    ),
    ...overrides,
  };
}

function createCaptureService(
  overrides: Partial<MemoryCaptureServiceInterface> = {}
): MemoryCaptureServiceInterface {
  return {
    startSession: vi.fn().mockResolvedValue(
      ok({
        workspaceId: 'codespace-cs1',
        sessionId: 'sess-1',
        agentPeerId: 'agent-a1',
        userPeerId: 'user-default',
      } satisfies HonchoSessionRef)
    ),
    captureMessage: vi.fn().mockResolvedValue(ok(undefined)),
    finalizeSession: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

const sampleConclusion: MemoryConclusion = {
  id: 'conc-1',
  content: 'Use Drizzle only',
  observerId: 'agent-a1',
  observedId: 'user-default',
  sessionId: 'sess-1',
  createdAt: '2026-01-01T00:00:00Z',
};

function createAdminService(
  overrides: Partial<MemoryAdminServiceInterface> = {}
): MemoryAdminServiceInterface {
  return {
    getConclusions: vi.fn().mockResolvedValue(ok([sampleConclusion])),
    createConclusion: vi.fn().mockResolvedValue(ok(sampleConclusion)),
    deleteConclusion: vi.fn().mockResolvedValue(ok(undefined)),
    getSessions: vi.fn().mockResolvedValue(ok([])),
    search: vi.fn().mockResolvedValue(ok([])),
    ...overrides,
  };
}

function buildService(): MemoryService {
  return new MemoryService(mockSettingsService as never, null);
}

const sessionParams = {
  codespaceId: 'cs1',
  agentId: 'a1',
  taskId: 't1',
  sessionId: 'sess-1',
  phase: 'execution' as const,
  model: 'claude-sonnet-4-6',
};

const contextParams = {
  codespaceId: 'cs1',
  agentId: 'a1',
  taskTitle: 'Fix bug',
  taskDescription: 'Some description',
};

const honchoRef: HonchoSessionRef = {
  workspaceId: 'codespace-cs1',
  sessionId: 'sess-1',
  agentPeerId: 'agent-a1',
  userPeerId: 'user-default',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientIsAvailable.mockReturnValue(false);
  });

  // =========================================================================
  // Lifecycle methods — swallow errors
  // =========================================================================

  describe('getContext()', () => {
    it('returns ok(EMPTY_CONTEXT) when client is unavailable', async () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();

      const result = await service.getContext(contextParams);

      expect(result).toEqual(ok(EMPTY_CONTEXT));
    });

    it('returns ok(EMPTY_CONTEXT) when queryService is null', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      // queryService is null by default

      const result = await service.getContext(contextParams);

      expect(result).toEqual(ok(EMPTY_CONTEXT));
    });

    it('returns ok(EMPTY_CONTEXT) when queryService throws', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      service.setQueryService(
        createQueryService({
          assembleContext: vi.fn().mockRejectedValue(new Error('network failure')),
        })
      );

      const result = await service.getContext(contextParams);

      expect(result).toEqual(ok(EMPTY_CONTEXT));
    });

    it('delegates to queryService when available', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const queryService = createQueryService();
      const service = buildService();
      service.setQueryService(queryService);

      const result = await service.getContext(contextParams);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toBe('memory context');
        expect(result.value.sources.conclusions).toBe(3);
      }
      expect(queryService.assembleContext).toHaveBeenCalledWith(contextParams);
    });
  });

  describe('startSession()', () => {
    it('returns null when client is unavailable', async () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();

      const result = await service.startSession(sessionParams);

      expect(result).toBeNull();
    });

    it('returns null when captureService is null', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      // captureService is null by default

      const result = await service.startSession(sessionParams);

      expect(result).toBeNull();
    });

    it('returns null when captureService throws', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      service.setCaptureService(
        createCaptureService({
          startSession: vi.fn().mockRejectedValue(new Error('boom')),
        })
      );

      const result = await service.startSession(sessionParams);

      expect(result).toBeNull();
    });

    it('delegates to captureService when available', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const captureService = createCaptureService();
      const service = buildService();
      service.setCaptureService(captureService);

      const result = await service.startSession(sessionParams);

      expect(result).not.toBeNull();
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.value.sessionId).toBe('sess-1');
      }
      expect(captureService.startSession).toHaveBeenCalledWith(sessionParams);
    });
  });

  describe('captureMessage()', () => {
    it('does not throw when captureService is null', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();

      await expect(
        service.captureMessage({
          honchoSessionRef: honchoRef,
          role: 'assistant',
          content: 'hello',
        })
      ).resolves.toBeUndefined();
    });

    it('does not throw when client is unavailable', async () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();
      service.setCaptureService(createCaptureService());

      await expect(
        service.captureMessage({
          honchoSessionRef: honchoRef,
          role: 'assistant',
          content: 'hello',
        })
      ).resolves.toBeUndefined();
    });

    it('does not throw when captureService throws', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      service.setCaptureService(
        createCaptureService({
          captureMessage: vi.fn().mockRejectedValue(new Error('capture explosion')),
        })
      );

      await expect(
        service.captureMessage({
          honchoSessionRef: honchoRef,
          role: 'user',
          content: 'help me',
        })
      ).resolves.toBeUndefined();
    });

    it('delegates to captureService when available', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const captureService = createCaptureService();
      const service = buildService();
      service.setCaptureService(captureService);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: 'Here is the fix',
        metadata: { tool: 'Edit' },
      });

      expect(captureService.captureMessage).toHaveBeenCalledWith({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: 'Here is the fix',
        metadata: { tool: 'Edit' },
      });
    });
  });

  describe('finalizeSession()', () => {
    it('does not throw when captureService is null', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();

      await expect(service.finalizeSession(honchoRef)).resolves.toBeUndefined();
    });

    it('does not throw when client is unavailable', async () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();
      service.setCaptureService(createCaptureService());

      await expect(service.finalizeSession(honchoRef)).resolves.toBeUndefined();
    });

    it('does not throw when captureService throws', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();
      service.setCaptureService(
        createCaptureService({
          finalizeSession: vi.fn().mockRejectedValue(new Error('finalize boom')),
        })
      );

      await expect(service.finalizeSession(honchoRef)).resolves.toBeUndefined();
    });

    it('delegates to captureService when available', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      const captureService = createCaptureService();
      const service = buildService();
      service.setCaptureService(captureService);

      await service.finalizeSession(honchoRef);

      expect(captureService.finalizeSession).toHaveBeenCalledWith(honchoRef);
    });
  });

  // =========================================================================
  // Admin methods — propagate errors
  // =========================================================================

  describe('createConclusion()', () => {
    it('returns err(UNAVAILABLE) when adminService is null', async () => {
      const service = buildService();

      const result = await service.createConclusion('cs1', 'some content');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_UNAVAILABLE');
      }
    });

    it('delegates to adminService when set', async () => {
      const adminService = createAdminService();
      const service = buildService();
      service.setAdminService(adminService);

      const result = await service.createConclusion('cs1', 'Use Drizzle only');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('Use Drizzle only');
      }
      expect(adminService.createConclusion).toHaveBeenCalledWith('cs1', 'Use Drizzle only');
    });
  });

  describe('deleteConclusion()', () => {
    it('returns err(UNAVAILABLE) when adminService is null', async () => {
      const service = buildService();

      const result = await service.deleteConclusion('cs1', 'conc-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_UNAVAILABLE');
      }
    });

    it('delegates to adminService when set', async () => {
      const adminService = createAdminService();
      const service = buildService();
      service.setAdminService(adminService);

      const result = await service.deleteConclusion('cs1', 'conc-1');

      expect(result.ok).toBe(true);
      expect(adminService.deleteConclusion).toHaveBeenCalledWith('cs1', 'conc-1');
    });
  });

  describe('getConclusions()', () => {
    it('returns ok([]) when adminService is null', async () => {
      const service = buildService();

      const result = await service.getConclusions('cs1');

      expect(result).toEqual(ok([]));
    });

    it('delegates to adminService when set', async () => {
      const adminService = createAdminService();
      const service = buildService();
      service.setAdminService(adminService);

      const result = await service.getConclusions('cs1', { page: 1, size: 20 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe('conc-1');
      }
      expect(adminService.getConclusions).toHaveBeenCalledWith('cs1', { page: 1, size: 20 });
    });
  });

  describe('getSessions()', () => {
    it('returns ok([]) when adminService is null', async () => {
      const service = buildService();

      const result = await service.getSessions('cs1');

      expect(result).toEqual(ok([]));
    });

    it('delegates to adminService when set', async () => {
      const adminService = createAdminService();
      const service = buildService();
      service.setAdminService(adminService);

      const result = await service.getSessions('cs1', { page: 2, size: 10 });

      expect(result.ok).toBe(true);
      expect(adminService.getSessions).toHaveBeenCalledWith('cs1', { page: 2, size: 10 });
    });
  });

  describe('search()', () => {
    it('returns ok([]) when adminService is null', async () => {
      const service = buildService();

      const result = await service.search('cs1', 'drizzle');

      expect(result).toEqual(ok([]));
    });

    it('delegates to adminService and returns results', async () => {
      const searchResult: SearchResult = {
        id: 'sr-1',
        content: 'Always use Drizzle',
        score: 0.95,
        type: 'conclusion',
        observerId: 'agent-a1',
        observedId: 'user-default',
        sessionId: 'sess-1',
        createdAt: '2026-01-01T00:00:00Z',
      };
      const adminService = createAdminService({
        search: vi.fn().mockResolvedValue(ok([searchResult])),
      });
      const service = buildService();
      service.setAdminService(adminService);

      const result = await service.search('cs1', 'drizzle', { limit: 5 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].content).toBe('Always use Drizzle');
      }
      expect(adminService.search).toHaveBeenCalledWith('cs1', 'drizzle', { limit: 5 });
    });
  });

  // =========================================================================
  // healthCheck
  // =========================================================================

  describe('healthCheck()', () => {
    it('returns available:false when ping fails', async () => {
      mockClientPing.mockResolvedValue(
        err(MemoryErrors.CONNECTION_FAILED('http://localhost:8000'))
      );
      const service = buildService();

      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available).toBe(false);
        expect(result.value.version).toBeNull();
        expect(typeof result.value.latencyMs).toBe('number');
        expect(result.value.workspaceCount).toBe(0);
      }
    });

    it('returns available:true with version when ping succeeds', async () => {
      mockClientPing.mockResolvedValue(ok({ status: 'ok', version: '1.2.3' }));
      const service = buildService();

      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available).toBe(true);
        expect(result.value.version).toBe('1.2.3');
        expect(typeof result.value.latencyMs).toBe('number');
      }
    });
  });

  // =========================================================================
  // deleteWorkspace
  // =========================================================================

  describe('deleteWorkspace()', () => {
    it('does nothing when client is unavailable', async () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();

      await expect(service.deleteWorkspace('cs1')).resolves.toBeUndefined();
      expect(mockClientDeleteWorkspace).not.toHaveBeenCalled();
    });

    it('calls client.deleteWorkspace with correct workspace name', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      mockClientDeleteWorkspace.mockResolvedValue(ok(undefined));
      const service = buildService();

      await service.deleteWorkspace('cs1');

      expect(mockClientDeleteWorkspace).toHaveBeenCalledWith('codespace-cs1');
    });

    it('does not throw on failure', async () => {
      mockClientIsAvailable.mockReturnValue(true);
      mockClientDeleteWorkspace.mockRejectedValue(new Error('workspace gone'));
      const service = buildService();

      await expect(service.deleteWorkspace('cs1')).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Accessors and initialization
  // =========================================================================

  describe('initialize()', () => {
    it('delegates to client.initialize()', async () => {
      mockClientInitialize.mockResolvedValue(undefined);
      const service = buildService();

      await service.initialize();

      expect(mockClientInitialize).toHaveBeenCalled();
    });
  });

  describe('isAvailable()', () => {
    it('returns client.isAvailable()', () => {
      mockClientIsAvailable.mockReturnValue(true);
      const service = buildService();

      expect(service.isAvailable()).toBe(true);
    });

    it('returns false when client is unavailable', () => {
      mockClientIsAvailable.mockReturnValue(false);
      const service = buildService();

      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('getClient()', () => {
    it('returns the underlying client service', () => {
      const service = buildService();
      const client = service.getClient();

      expect(client).toBeDefined();
      expect(typeof client.isAvailable).toBe('function');
    });
  });

  describe('getSettingsService()', () => {
    it('returns the settings service', () => {
      const service = buildService();
      const settings = service.getSettingsService();

      expect(settings).toBe(mockSettingsService);
    });
  });
});
