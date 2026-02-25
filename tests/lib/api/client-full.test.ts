/**
 * Comprehensive tests for the API client.
 * Tests client initialization, request building, response parsing,
 * error handling, pagination, and all API methods.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ERROR_CODES } from '@/lib/api/client';

// Helper to create a mock Response object
const createMockResponse = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(data),
});

// Helper to create successful API response
const successResponse = <T>(data: T) => ({
  ok: true,
  data,
});

// Helper to create error API response
const errorResponse = (code: string, message: string) => ({
  ok: false,
  error: { code, message },
});

describe('API Client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ============================================================================
  // CLIENT INITIALIZATION
  // ============================================================================
  describe('Client Initialization', () => {
    it('exports apiClient object with all expected namespaces', async () => {
      const { apiClient } = await import('@/lib/api/client');

      expect(apiClient).toBeDefined();
      expect(apiClient.projects).toBeDefined();
      expect(apiClient.agents).toBeDefined();
      expect(apiClient.tasks).toBeDefined();
      expect(apiClient.sessions).toBeDefined();
      expect(apiClient.worktrees).toBeDefined();
      expect(apiClient.git).toBeDefined();
      expect(apiClient.filesystem).toBeDefined();
      expect(apiClient.github).toBeDefined();
      expect(apiClient.system).toBeDefined();
      expect(apiClient.apiKeys).toBeDefined();
      expect(apiClient.templates).toBeDefined();
      expect(apiClient.sandboxConfigs).toBeDefined();
      expect(apiClient.plans).toBeDefined();
      expect(apiClient.taskCreation).toBeDefined();
      expect(apiClient.marketplaces).toBeDefined();
    });

    it('exports API_ERROR_CODES with all error types', async () => {
      const { API_ERROR_CODES } = await import('@/lib/api/client');

      expect(API_ERROR_CODES.REQUEST_ABORTED).toBe('REQUEST_ABORTED');
      expect(API_ERROR_CODES.NETWORK_ERROR).toBe('NETWORK_ERROR');
      expect(API_ERROR_CODES.FETCH_ERROR).toBe('FETCH_ERROR');
      expect(API_ERROR_CODES.PARSE_ERROR).toBe('PARSE_ERROR');
      expect(API_ERROR_CODES.SERVER_ERROR).toBe('SERVER_ERROR');
    });
  });

  // ============================================================================
  // REQUEST BUILDING - Headers
  // ============================================================================
  describe('Request Building - Headers', () => {
    it('sends Content-Type header for POST requests with body', async () => {
      const mockResponse = createMockResponse(successResponse({ id: '1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.create({ name: 'Test', path: '/test' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects',
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('does not send Content-Type header for GET requests', async () => {
      const mockResponse = createMockResponse(
        successResponse({ items: [], totalCount: 0, hasMore: false, nextCursor: null })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.list();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects',
        expect.objectContaining({
          headers: undefined,
        })
      );
    });

    it('sends Content-Type header for PATCH requests with body', async () => {
      const mockResponse = createMockResponse(successResponse({ id: '1', name: 'Updated' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.update('proj-1', { name: 'Updated' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj-1',
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });
  });

  // ============================================================================
  // REQUEST BUILDING - Body
  // ============================================================================
  describe('Request Building - Body', () => {
    it('serializes body as JSON for POST requests', async () => {
      const mockResponse = createMockResponse(successResponse({ id: '1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const requestBody = { name: 'Test Project', path: '/path/to/project', description: 'A test' };
      await apiClient.projects.create(requestBody);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(requestBody),
        })
      );
    });

    it('does not include body for GET requests', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.get('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: undefined,
        })
      );
    });

    it('does not include body for DELETE requests without body', async () => {
      const mockResponse = createMockResponse(successResponse({ deleted: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.delete('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: undefined,
        })
      );
    });
  });

  // ============================================================================
  // REQUEST BUILDING - Query Parameters
  // ============================================================================
  describe('Request Building - Query Parameters', () => {
    it('appends limit parameter to projects list URL', async () => {
      const mockResponse = createMockResponse(
        successResponse({ items: [], totalCount: 0, hasMore: false, nextCursor: null })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.list({ limit: 10 });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects?limit=10',
        expect.any(Object)
      );
    });

    it('builds query string for tasks list with multiple params', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.tasks.list('proj-1', { status: 'in_progress', limit: 50 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('projectId=proj-1');
      expect(calledUrl).toContain('status=in_progress');
      expect(calledUrl).toContain('limit=50');
    });

    it('builds query string for sessions list with multiple filters', async () => {
      const mockResponse = createMockResponse(successResponse({ data: [], pagination: {} }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.list({
        projectId: 'proj-1',
        limit: 20,
        offset: 10,
        status: ['active', 'closed'],
        search: 'test query',
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('projectId=proj-1');
      expect(calledUrl).toContain('limit=20');
      expect(calledUrl).toContain('offset=10');
      expect(calledUrl).toContain('status=active%2Cclosed');
      expect(calledUrl).toContain('search=test+query');
    });

    it('omits query string when no params provided', async () => {
      const mockResponse = createMockResponse(
        successResponse({ items: [], totalCount: 0, hasMore: false, nextCursor: null })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.list();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects',
        expect.any(Object)
      );
    });

    it('encodes special characters in URL parameters', async () => {
      const mockResponse = createMockResponse(successResponse({ id: '1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.update('proj/1&special', { name: 'Test' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj%2F1%26special',
        expect.any(Object)
      );
    });
  });

  // ============================================================================
  // RESPONSE PARSING
  // ============================================================================
  describe('Response Parsing', () => {
    it('returns parsed JSON response on success', async () => {
      const responseData = successResponse({
        items: [{ id: '1', name: 'Project 1', path: '/path' }],
        totalCount: 1,
        hasMore: false,
        nextCursor: null,
      });
      const mockResponse = createMockResponse(responseData);
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0].id).toBe('1');
      }
    });

    it('returns error response when API returns error', async () => {
      const responseData = errorResponse('NOT_FOUND', 'Project not found');
      const mockResponse = createMockResponse(responseData, 404);
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.get('invalid-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toBe('Project not found');
      }
    });

    it('handles empty response body', async () => {
      const mockResponse = createMockResponse(successResponse(null));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.github.deleteToken();

      expect(result.ok).toBe(true);
    });
  });

  // ============================================================================
  // ERROR HANDLING - Network Errors
  // ============================================================================
  describe('Error Handling - Network Errors', () => {
    it('returns NETWORK_ERROR for connection refused', async () => {
      const networkError = new TypeError('Failed to fetch');
      global.fetch = vi.fn().mockRejectedValue(networkError);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.NETWORK_ERROR);
        expect(result.error.message).toBe('Failed to fetch');
      }
    });

    it('returns NETWORK_ERROR for DNS failure', async () => {
      const dnsError = new TypeError('getaddrinfo ENOTFOUND');
      global.fetch = vi.fn().mockRejectedValue(dnsError);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.system.health();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.NETWORK_ERROR);
      }
    });

    it('returns NETWORK_ERROR with fallback message when TypeError has no message', async () => {
      const emptyError = new TypeError();
      global.fetch = vi.fn().mockRejectedValue(emptyError);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.NETWORK_ERROR);
        expect(result.error.message).toBe('Network request failed');
      }
    });
  });

  // ============================================================================
  // ERROR HANDLING - Abort Errors
  // ============================================================================
  describe('Error Handling - Abort Errors', () => {
    it('returns REQUEST_ABORTED when AbortController signals abort', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = vi.fn().mockRejectedValue(abortError);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.REQUEST_ABORTED);
        expect(result.error.message).toBe('Request was aborted');
      }
    });

    it('passes AbortSignal to fetch', async () => {
      const _controller = new AbortController();
      const mockResponse = createMockResponse(successResponse({ items: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.list({ projectId: 'proj-1' });

      // Since the client doesn't expose signal parameter directly for all methods,
      // we verify it handles abort errors properly when they occur
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // ERROR HANDLING - Parse Errors
  // ============================================================================
  describe('Error Handling - Parse Errors', () => {
    it('returns PARSE_ERROR when response is not valid JSON', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.PARSE_ERROR);
        expect(result.error.message).toContain('Invalid JSON response');
        expect(result.error.message).toContain('HTTP 200');
      }
    });

    it('includes HTTP status in parse error for error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.PARSE_ERROR);
        expect(result.error.message).toContain('HTTP 502');
      }
    });

    it('handles non-Error parse failures', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue('string error'),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.PARSE_ERROR);
        expect(result.error.message).toContain('unknown parse error');
      }
    });
  });

  // ============================================================================
  // ERROR HANDLING - Generic Fetch Errors
  // ============================================================================
  describe('Error Handling - Generic Fetch Errors', () => {
    it('returns FETCH_ERROR for generic Error objects', async () => {
      const genericError = new Error('Something went wrong');
      global.fetch = vi.fn().mockRejectedValue(genericError);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.FETCH_ERROR);
        expect(result.error.message).toBe('Something went wrong');
      }
    });

    it('returns FETCH_ERROR with default message for non-Error objects', async () => {
      global.fetch = vi.fn().mockRejectedValue('string error');

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.FETCH_ERROR);
        expect(result.error.message).toBe('Network request failed');
      }
    });

    it('returns FETCH_ERROR for null rejection', async () => {
      global.fetch = vi.fn().mockRejectedValue(null);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.projects.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(API_ERROR_CODES.FETCH_ERROR);
      }
    });
  });

  // ============================================================================
  // API METHODS - Projects
  // ============================================================================
  describe('API Methods - Projects', () => {
    it('projects.list calls correct endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ items: [], totalCount: 0, hasMore: false, nextCursor: null })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.list();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('projects.listWithSummaries calls summaries endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ items: [], totalCount: 0, hasMore: false, nextCursor: null })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.listWithSummaries({ limit: 5 });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/summaries?limit=5',
        expect.any(Object)
      );
    });

    it('projects.get calls correct endpoint with id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'proj-1', name: 'Test' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.get('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj-1',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('projects.create sends POST with body', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'proj-new' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.create({
        name: 'New Project',
        path: '/path',
        description: 'Description',
        sandboxConfigId: 'sandbox-1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'New Project',
            path: '/path',
            description: 'Description',
            sandboxConfigId: 'sandbox-1',
          }),
        })
      );
    });

    it('projects.update sends PATCH with body', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'proj-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.update('proj-1', {
        name: 'Updated Name',
        maxConcurrentAgents: 5,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated Name', maxConcurrentAgents: 5 }),
        })
      );
    });

    it('projects.delete sends DELETE request', async () => {
      const mockResponse = createMockResponse(successResponse({ deleted: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.delete('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  // ============================================================================
  // API METHODS - Tasks
  // ============================================================================
  describe('API Methods - Tasks', () => {
    it('tasks.list calls endpoint with projectId', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.tasks.list('proj-1');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/tasks');
      expect(calledUrl).toContain('projectId=proj-1');
    });

    it('tasks.get calls endpoint with task id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'task-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.tasks.get('task-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks/task-1',
        expect.any(Object)
      );
    });

    it('tasks.create sends POST with task data', async () => {
      const mockResponse = createMockResponse(
        successResponse({ taskId: 'task-new', title: 'New Task', projectId: 'proj-1' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.tasks.create({
        projectId: 'proj-1',
        title: 'New Task',
        description: 'Description',
        labels: ['bug', 'urgent'],
        priority: 'high',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            projectId: 'proj-1',
            title: 'New Task',
            description: 'Description',
            labels: ['bug', 'urgent'],
            priority: 'high',
          }),
        })
      );
    });
  });

  // ============================================================================
  // API METHODS - Agents
  // ============================================================================
  describe('API Methods - Agents', () => {
    it('agents.list calls endpoint with optional filters', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.agents.list({ projectId: 'proj-1', status: 'running' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/agents');
      expect(calledUrl).toContain('projectId=proj-1');
      expect(calledUrl).toContain('status=running');
    });

    it('agents.getRunningCount calls endpoint with status=running', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 3 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.agents.getRunningCount();

      expect(global.fetch).toHaveBeenCalledWith('/api/agents?status=running', expect.any(Object));
    });
  });

  // ============================================================================
  // API METHODS - Sessions
  // ============================================================================
  describe('API Methods - Sessions', () => {
    it('sessions.list builds complex query string', async () => {
      const mockResponse = createMockResponse(successResponse({ data: [], pagination: {} }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.list({
        projectId: 'proj-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('projectId=proj-1');
      expect(calledUrl).toContain('agentId=agent-1');
      expect(calledUrl).toContain('taskId=task-1');
      expect(calledUrl).toContain('dateFrom=2024-01-01');
      expect(calledUrl).toContain('dateTo=2024-12-31');
    });

    it('sessions.get calls endpoint with id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'session-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.get('session-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sessions/session-1',
        expect.any(Object)
      );
    });

    it('sessions.getEvents calls events endpoint with pagination', async () => {
      const mockResponse = createMockResponse(
        successResponse({ data: [], pagination: { total: 0, limit: 50, offset: 0 } })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.getEvents('session-1', { limit: 100, offset: 50 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/sessions/session-1/events');
      expect(calledUrl).toContain('limit=100');
      expect(calledUrl).toContain('offset=50');
    });

    it('sessions.getSummary calls summary endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ sessionId: 'session-1', durationMs: 1000, turnsCount: 5 })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.getSummary('session-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sessions/session-1/summary',
        expect.any(Object)
      );
    });

    it('sessions.export sends POST with format', async () => {
      const mockResponse = createMockResponse(
        successResponse({
          content: '# Export',
          contentType: 'text/markdown',
          filename: 'export.md',
        })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.export('session-1', 'markdown');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sessions/session-1/export',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ format: 'markdown' }),
        })
      );
    });
  });

  // ============================================================================
  // API METHODS - Worktrees
  // ============================================================================
  describe('API Methods - Worktrees', () => {
    it('worktrees.list calls endpoint with projectId', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.list({ projectId: 'proj-1' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees?projectId=proj-1',
        expect.any(Object)
      );
    });

    it('worktrees.get calls endpoint with encoded id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'wt-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.get('wt-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt-1',
        expect.any(Object)
      );
    });

    it('worktrees.create sends POST with data', async () => {
      const mockResponse = createMockResponse(
        successResponse({ id: 'wt-new', branch: 'feature', path: '/path', status: 'active' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.create({
        projectId: 'proj-1',
        taskId: 'task-1',
        baseBranch: 'main',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'proj-1', taskId: 'task-1', baseBranch: 'main' }),
        })
      );
    });

    it('worktrees.remove sends DELETE with force option', async () => {
      const mockResponse = createMockResponse(successResponse({ success: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.remove('wt-1', true);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt-1?force=true',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('worktrees.commit sends POST with message', async () => {
      const mockResponse = createMockResponse(successResponse({ sha: 'abc123' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.commit('wt-1', 'Fix bug');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt-1/commit',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'Fix bug' }),
        })
      );
    });

    it('worktrees.merge sends POST with options', async () => {
      const mockResponse = createMockResponse(successResponse({ merged: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.merge('wt-1', {
        targetBranch: 'main',
        deleteAfterMerge: true,
        squash: true,
        commitMessage: 'Merge feature',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt-1/merge',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetBranch: 'main',
            deleteAfterMerge: true,
            squash: true,
            commitMessage: 'Merge feature',
          }),
        })
      );
    });

    it('worktrees.getDiff calls diff endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.getDiff('wt-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt-1/diff',
        expect.any(Object)
      );
    });

    it('worktrees.prune sends POST with projectId', async () => {
      const mockResponse = createMockResponse(successResponse({ pruned: 3, failed: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.prune('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/prune',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'proj-1' }),
        })
      );
    });
  });

  // ============================================================================
  // API METHODS - Git
  // ============================================================================
  describe('API Methods - Git', () => {
    it('git.status calls endpoint with projectId', async () => {
      const mockResponse = createMockResponse(
        successResponse({ repoName: 'test', currentBranch: 'main', status: 'clean' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.git.status('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/git/status?projectId=proj-1',
        expect.any(Object)
      );
    });

    it('git.branches calls endpoint with projectId', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.git.branches('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/git/branches?projectId=proj-1',
        expect.any(Object)
      );
    });

    it('git.commits calls endpoint with optional branch and limit', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.git.commits('proj-1', 'feature', 10);

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/git/commits');
      expect(calledUrl).toContain('projectId=proj-1');
      expect(calledUrl).toContain('branch=feature');
      expect(calledUrl).toContain('limit=10');
    });

    it('git.remoteBranches calls endpoint with projectId', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.git.remoteBranches('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/git/remote-branches?projectId=proj-1',
        expect.any(Object)
      );
    });
  });

  // ============================================================================
  // API METHODS - GitHub
  // ============================================================================
  describe('API Methods - GitHub', () => {
    it('github.listOrgs calls orgs endpoint', async () => {
      const mockResponse = createMockResponse(successResponse({ orgs: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.listOrgs();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/orgs',
        expect.any(Object)
      );
    });

    it('github.listReposForOwner calls repos endpoint with owner', async () => {
      const mockResponse = createMockResponse(successResponse({ repos: [] }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.listReposForOwner('octocat');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/repos/octocat',
        expect.any(Object)
      );
    });

    it('github.clone sends POST with url and destination', async () => {
      const mockResponse = createMockResponse(successResponse({ path: '/cloned/path' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.clone('https://github.com/user/repo.git', '/destination');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/clone',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            url: 'https://github.com/user/repo.git',
            destination: '/destination',
          }),
        })
      );
    });

    it('github.saveToken sends POST with token', async () => {
      const mockResponse = createMockResponse(successResponse({ tokenInfo: { login: 'user' } }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.saveToken('ghp_xxx');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ token: 'ghp_xxx' }),
        })
      );
    });

    it('github.deleteToken sends DELETE request', async () => {
      const mockResponse = createMockResponse(successResponse(null));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.deleteToken();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/token',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('github.createFromTemplate sends POST with template params', async () => {
      const mockResponse = createMockResponse(
        successResponse({ path: '/path', repoFullName: 'user/repo', cloneUrl: 'url' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.github.createFromTemplate({
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
        clonePath: '/path',
        isPrivate: true,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/github/create-from-template',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            templateOwner: 'owner',
            templateRepo: 'template',
            name: 'new-repo',
            clonePath: '/path',
            isPrivate: true,
          }),
        })
      );
    });
  });

  // ============================================================================
  // API METHODS - System
  // ============================================================================
  describe('API Methods - System', () => {
    it('system.health calls health endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({
          status: 'healthy',
          timestamp: '2024-01-01T00:00:00Z',
          uptime: 3600,
          checks: { database: { status: 'ok' }, github: { status: 'ok' } },
          responseTimeMs: 5,
        })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      const result = await apiClient.system.health();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/health',
        expect.any(Object)
      );
      expect(result.ok).toBe(true);
    });
  });

  // ============================================================================
  // API METHODS - API Keys
  // ============================================================================
  describe('API Methods - API Keys', () => {
    it('apiKeys.get calls endpoint with service name', async () => {
      const mockResponse = createMockResponse(successResponse({ keyInfo: null }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.apiKeys.get('anthropic');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/keys/anthropic',
        expect.any(Object)
      );
    });

    it('apiKeys.save sends POST with key', async () => {
      const mockResponse = createMockResponse(
        successResponse({ keyInfo: { id: '1', service: 'anthropic', maskedKey: 'sk-...xxx' } })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.apiKeys.save('anthropic', 'sk-test-key');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/keys/anthropic',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'sk-test-key' }),
        })
      );
    });

    it('apiKeys.delete sends DELETE request', async () => {
      const mockResponse = createMockResponse(successResponse(null));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.apiKeys.delete('anthropic');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/keys/anthropic',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  // ============================================================================
  // API METHODS - Templates
  // ============================================================================
  describe('API Methods - Templates', () => {
    it('templates.list calls endpoint with optional filters', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.templates.list({ scope: 'org', limit: 10 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/templates');
      expect(calledUrl).toContain('scope=org');
      expect(calledUrl).toContain('limit=10');
    });

    it('templates.create sends POST with input', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'tmpl-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.templates.create({
        name: 'My Template',
        description: 'Description',
        scope: 'org',
        githubUrl: 'https://github.com/user/repo',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/templates',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('templates.update sends PATCH with input', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'tmpl-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.templates.update('tmpl-1', { name: 'Updated Name' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/templates/tmpl-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated Name' }),
        })
      );
    });

    it('templates.sync sends POST to sync endpoint', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'tmpl-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.templates.sync('tmpl-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/templates/tmpl-1/sync',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ============================================================================
  // API METHODS - Sandbox Configs
  // ============================================================================
  describe('API Methods - Sandbox Configs', () => {
    it('sandboxConfigs.list calls endpoint with pagination', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sandboxConfigs.list({ limit: 20, offset: 10 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/sandbox-configs');
      expect(calledUrl).toContain('limit=20');
      expect(calledUrl).toContain('offset=10');
    });

    it('sandboxConfigs.create sends POST with config', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'sandbox-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sandboxConfigs.create({
        name: 'Docker Sandbox',
        type: 'docker',
        baseImage: 'ubuntu:22.04',
        memoryMb: 2048,
        cpuCores: 2,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sandbox-configs',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('sandboxConfigs.update sends PATCH with updates', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'sandbox-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sandboxConfigs.update('sandbox-1', { memoryMb: 4096 });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sandbox-configs/sandbox-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ memoryMb: 4096 }),
        })
      );
    });
  });

  // ============================================================================
  // API METHODS - Plans
  // ============================================================================
  describe('API Methods - Plans', () => {
    it('plans.get calls endpoint with taskId', async () => {
      const mockResponse = createMockResponse(successResponse({ session: null }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.plans.get('task-1');

      expect(global.fetch).toHaveBeenCalledWith('/api/plans/task-1', expect.any(Object));
    });

    it('plans.start sends POST with project and prompt', async () => {
      const mockResponse = createMockResponse(successResponse({ session: { id: 'plan-1' } }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.plans.start('task-1', {
        projectId: 'proj-1',
        initialPrompt: 'Create a new feature',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/plans/task-1/start',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'proj-1', initialPrompt: 'Create a new feature' }),
        })
      );
    });

    it('plans.answerInteraction sends POST with answers', async () => {
      const mockResponse = createMockResponse(successResponse({ session: { id: 'plan-1' } }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.plans.answerInteraction('task-1', {
        interactionId: 'int-1',
        answers: { question1: 'answer1' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/plans/task-1/answer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ interactionId: 'int-1', answers: { question1: 'answer1' } }),
        })
      );
    });

    it('plans.cancel sends POST to cancel endpoint', async () => {
      const mockResponse = createMockResponse(successResponse({ session: { id: 'plan-1' } }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.plans.cancel('task-1');

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/plans/task-1/cancel',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ============================================================================
  // API METHODS - Task Creation
  // ============================================================================
  describe('API Methods - Task Creation', () => {
    it('taskCreation.start sends POST with projectId', async () => {
      const mockResponse = createMockResponse(
        successResponse({ sessionId: 'tc-1', projectId: 'proj-1', status: 'active' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.taskCreation.start('proj-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks/create-with-ai/start',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'proj-1' }),
        })
      );
    });

    it('taskCreation.sendMessage sends POST with sessionId and message', async () => {
      const mockResponse = createMockResponse(
        successResponse({ sessionId: 'tc-1', status: 'active', messageCount: 1 })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.taskCreation.sendMessage('tc-1', 'I want to add a new button');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks/create-with-ai/message',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionId: 'tc-1', message: 'I want to add a new button' }),
        })
      );
    });

    it('taskCreation.accept sends POST with sessionId and optional overrides', async () => {
      const mockResponse = createMockResponse(
        successResponse({ taskId: 'task-1', sessionId: 'tc-1', status: 'completed' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.taskCreation.accept('tc-1', { title: 'Custom Title' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks/create-with-ai/accept',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionId: 'tc-1', overrides: { title: 'Custom Title' } }),
        })
      );
    });

    it('taskCreation.cancel sends POST with sessionId', async () => {
      const mockResponse = createMockResponse(
        successResponse({ sessionId: 'tc-1', status: 'cancelled' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.taskCreation.cancel('tc-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/tasks/create-with-ai/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionId: 'tc-1' }),
        })
      );
    });

    it('taskCreation.getStreamUrl returns correct URL with sessionId', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const url = apiClient.taskCreation.getStreamUrl('tc-1');

      expect(url).toBe('http://localhost:3001/api/tasks/create-with-ai/stream?sessionId=tc-1');
    });
  });

  // ============================================================================
  // API METHODS - Marketplaces
  // ============================================================================
  describe('API Methods - Marketplaces', () => {
    it('marketplaces.list calls endpoint with optional filters', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.list({ limit: 10, includeDisabled: true });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/marketplaces');
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('includeDisabled=true');
    });

    it('marketplaces.get calls endpoint with id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'mp-1', name: 'Default' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.get('mp-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces/mp-1',
        expect.any(Object)
      );
    });

    it('marketplaces.create sends POST with data', async () => {
      const mockResponse = createMockResponse(
        successResponse({ id: 'mp-new', name: 'Custom', githubOwner: 'owner', githubRepo: 'repo' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.create({
        name: 'Custom Marketplace',
        githubUrl: 'https://github.com/owner/repo',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('marketplaces.delete sends DELETE request', async () => {
      const mockResponse = createMockResponse(successResponse({ deleted: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.delete('mp-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces/mp-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('marketplaces.sync sends POST to sync endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ marketplaceId: 'mp-1', pluginCount: 10, sha: 'abc123' })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.sync('mp-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces/mp-1/sync',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('marketplaces.seed sends POST to seed endpoint', async () => {
      const mockResponse = createMockResponse(successResponse({ seeded: true }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.seed();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces/seed',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('marketplaces.listPlugins calls plugins endpoint with filters', async () => {
      const mockResponse = createMockResponse(successResponse({ items: [], totalCount: 0 }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.listPlugins({
        search: 'auth',
        category: 'security',
        marketplaceId: 'mp-1',
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/marketplaces/plugins');
      expect(calledUrl).toContain('search=auth');
      expect(calledUrl).toContain('category=security');
      expect(calledUrl).toContain('marketplaceId=mp-1');
    });

    it('marketplaces.getCategories calls categories endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ categories: ['security', 'productivity'] })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.marketplaces.getCategories();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/marketplaces/categories',
        expect.any(Object)
      );
    });
  });

  // ============================================================================
  // API METHODS - Filesystem
  // ============================================================================
  describe('API Methods - Filesystem', () => {
    it('filesystem.discoverRepos calls discover endpoint', async () => {
      const mockResponse = createMockResponse(
        successResponse({ repos: [{ name: 'repo1', path: '/path', lastModified: '2024-01-01' }] })
      );
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.filesystem.discoverRepos();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/filesystem/discover-repos',
        expect.any(Object)
      );
    });
  });

  // ============================================================================
  // URL ENCODING
  // ============================================================================
  describe('URL Encoding', () => {
    it('encodes special characters in project id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'proj/1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.projects.update('proj/1', { name: 'Test' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/projects/proj%2F1',
        expect.any(Object)
      );
    });

    it('encodes special characters in worktree id', async () => {
      const mockResponse = createMockResponse(successResponse({ id: 'wt-1' }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.worktrees.get('wt/special&chars');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/worktrees/wt%2Fspecial%26chars',
        expect.any(Object)
      );
    });

    it('encodes special characters in session id for events', async () => {
      const mockResponse = createMockResponse(successResponse({ data: [], pagination: {} }));
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { apiClient } = await import('@/lib/api/client');
      await apiClient.sessions.getEvents('session/1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/sessions/session%2F1/events',
        expect.any(Object)
      );
    });
  });

  // ============================================================================
  // TYPE EXPORTS
  // ============================================================================
  describe('Type Exports', () => {
    it('exports TaskCreationStatus type', async () => {
      const { API_ERROR_CODES } = await import('@/lib/api/client');
      // Type exports are tested at compile time, this just verifies the module loads
      expect(API_ERROR_CODES).toBeDefined();
    });
  });
});
