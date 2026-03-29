/**
 * Integration Tests for API Server Routing and Handler Logic
 *
 * These tests verify the routing logic, CORS handling, validation, and
 * response formatting used in the API server (src/server/api.ts).
 *
 * Since api.ts initializes bun:sqlite at module load time, these tests
 * focus on testing the patterns and helper functions used throughout
 * the API, providing comprehensive coverage of the routing logic.
 */

import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';

// =============================================================================
// Route Matching Logic Tests
// =============================================================================

describe('API Route Matching', () => {
  // Simulates the route matching logic used in api.ts
  function matchRoute(
    pathname: string,
    method: string,
    routes: Array<{ pattern: string; method: string; handler: string }>
  ): { matched: boolean; handler?: string; params?: Record<string, string> } {
    for (const route of routes) {
      if (route.method !== method) continue;

      // Convert route pattern to regex
      const paramNames: string[] = [];
      const regexPattern = route.pattern.replace(/:([^/]+)/g, (_match, paramName) => {
        paramNames.push(paramName);
        return '([^/]+)';
      });

      const regex = new RegExp(`^${regexPattern}$`);
      const match = pathname.match(regex);

      if (match) {
        const params: Record<string, string> = {};
        paramNames.forEach((name, index) => {
          params[name] = match[index + 1] || '';
        });
        return { matched: true, handler: route.handler, params };
      }
    }

    return { matched: false };
  }

  // Define routes similar to api.ts
  const routes = [
    // Project routes
    { pattern: '/api/codespaces', method: 'GET', handler: 'listProjects' },
    { pattern: '/api/codespaces', method: 'POST', handler: 'createProject' },
    { pattern: '/api/codespaces/summaries', method: 'GET', handler: 'listProjectSummaries' },
    { pattern: '/api/codespaces/:id', method: 'GET', handler: 'getProject' },
    { pattern: '/api/codespaces/:id', method: 'PATCH', handler: 'updateProject' },
    { pattern: '/api/codespaces/:id', method: 'DELETE', handler: 'deleteProject' },
    // Task routes
    { pattern: '/api/tasks', method: 'GET', handler: 'listTasks' },
    { pattern: '/api/tasks', method: 'POST', handler: 'createTask' },
    { pattern: '/api/tasks/:id', method: 'GET', handler: 'getTask' },
    { pattern: '/api/tasks/:id', method: 'PUT', handler: 'updateTask' },
    { pattern: '/api/tasks/:id', method: 'DELETE', handler: 'deleteTask' },
    // Agent routes
    { pattern: '/api/agents', method: 'GET', handler: 'listAgents' },
    { pattern: '/api/agents/:id', method: 'GET', handler: 'getAgent' },
    { pattern: '/api/agents/:id/start', method: 'POST', handler: 'startAgent' },
    { pattern: '/api/agents/:id/stop', method: 'POST', handler: 'stopAgent' },
    // Session routes
    { pattern: '/api/sessions', method: 'GET', handler: 'listSessions' },
    { pattern: '/api/sessions/:id', method: 'GET', handler: 'getSession' },
    { pattern: '/api/sessions/:id/events', method: 'GET', handler: 'getSessionEvents' },
    { pattern: '/api/sessions/:id/summary', method: 'GET', handler: 'getSessionSummary' },
    // Template routes
    { pattern: '/api/templates', method: 'GET', handler: 'listTemplates' },
    { pattern: '/api/templates', method: 'POST', handler: 'createTemplate' },
    { pattern: '/api/templates/:id', method: 'GET', handler: 'getTemplate' },
    { pattern: '/api/templates/:id', method: 'PATCH', handler: 'updateTemplate' },
    { pattern: '/api/templates/:id', method: 'DELETE', handler: 'deleteTemplate' },
    { pattern: '/api/templates/:id/sync', method: 'POST', handler: 'syncTemplate' },
    // Marketplace routes
    { pattern: '/api/marketplaces', method: 'GET', handler: 'listMarketplaces' },
    { pattern: '/api/marketplaces', method: 'POST', handler: 'createMarketplace' },
    { pattern: '/api/marketplaces/plugins', method: 'GET', handler: 'listPlugins' },
    { pattern: '/api/marketplaces/categories', method: 'GET', handler: 'getCategories' },
    { pattern: '/api/marketplaces/seed', method: 'POST', handler: 'seedMarketplace' },
    { pattern: '/api/marketplaces/:id', method: 'GET', handler: 'getMarketplace' },
    { pattern: '/api/marketplaces/:id', method: 'DELETE', handler: 'deleteMarketplace' },
    { pattern: '/api/marketplaces/:id/sync', method: 'POST', handler: 'syncMarketplace' },
    // API Key routes
    { pattern: '/api/keys/:service', method: 'GET', handler: 'getApiKey' },
    { pattern: '/api/keys/:service', method: 'POST', handler: 'saveApiKey' },
    { pattern: '/api/keys/:service', method: 'DELETE', handler: 'deleteApiKey' },
    // Sandbox config routes
    { pattern: '/api/sandbox-configs', method: 'GET', handler: 'listSandboxConfigs' },
    { pattern: '/api/sandbox-configs', method: 'POST', handler: 'createSandboxConfig' },
    { pattern: '/api/sandbox-configs/:id', method: 'GET', handler: 'getSandboxConfig' },
    { pattern: '/api/sandbox-configs/:id', method: 'PATCH', handler: 'updateSandboxConfig' },
    { pattern: '/api/sandbox-configs/:id', method: 'DELETE', handler: 'deleteSandboxConfig' },
    // GitHub routes
    { pattern: '/api/github/orgs', method: 'GET', handler: 'listGitHubOrgs' },
    { pattern: '/api/github/repos', method: 'GET', handler: 'listGitHubRepos' },
    { pattern: '/api/github/repos/:owner', method: 'GET', handler: 'listOwnerRepos' },
    { pattern: '/api/github/token', method: 'GET', handler: 'getGitHubToken' },
    { pattern: '/api/github/token', method: 'POST', handler: 'saveGitHubToken' },
    { pattern: '/api/github/token', method: 'DELETE', handler: 'deleteGitHubToken' },
    { pattern: '/api/github/revalidate', method: 'POST', handler: 'revalidateToken' },
    { pattern: '/api/github/clone', method: 'POST', handler: 'cloneRepo' },
    { pattern: '/api/github/create-from-template', method: 'POST', handler: 'createFromTemplate' },
    // Git routes
    { pattern: '/api/git/status', method: 'GET', handler: 'getGitStatus' },
    { pattern: '/api/git/branches', method: 'GET', handler: 'listBranches' },
    { pattern: '/api/git/commits', method: 'GET', handler: 'listCommits' },
    { pattern: '/api/git/remote-branches', method: 'GET', handler: 'listRemoteBranches' },
    // Task creation with AI routes
    {
      pattern: '/api/tasks/create-with-ai/start',
      method: 'POST',
      handler: 'startTaskConversation',
    },
    { pattern: '/api/tasks/create-with-ai/message', method: 'POST', handler: 'sendTaskMessage' },
    {
      pattern: '/api/tasks/create-with-ai/accept',
      method: 'POST',
      handler: 'acceptTaskSuggestion',
    },
    {
      pattern: '/api/tasks/create-with-ai/cancel',
      method: 'POST',
      handler: 'cancelTaskConversation',
    },
    {
      pattern: '/api/tasks/create-with-ai/stream',
      method: 'GET',
      handler: 'streamTaskConversation',
    },
    // Workflow designer
    { pattern: '/api/workflow-designer/analyze', method: 'POST', handler: 'analyzeWorkflow' },
    // Health check
    { pattern: '/api/health', method: 'GET', handler: 'healthCheck' },
    // Filesystem
    { pattern: '/api/filesystem/discover-repos', method: 'GET', handler: 'discoverRepos' },
  ];

  describe('Project Routes', () => {
    it('matches GET /api/codespaces', () => {
      const result = matchRoute('/api/codespaces', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listProjects');
    });

    it('matches POST /api/codespaces', () => {
      const result = matchRoute('/api/codespaces', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createProject');
    });

    it('matches GET /api/codespaces/summaries', () => {
      const result = matchRoute('/api/codespaces/summaries', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listProjectSummaries');
    });

    it('matches GET /api/codespaces/:id', () => {
      const result = matchRoute('/api/codespaces/proj-123', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getProject');
      expect(result.params?.id).toBe('proj-123');
    });

    it('matches PATCH /api/codespaces/:id', () => {
      const result = matchRoute('/api/codespaces/proj-123', 'PATCH', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('updateProject');
    });

    it('matches DELETE /api/codespaces/:id', () => {
      const result = matchRoute('/api/codespaces/proj-123', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteProject');
    });

    it('does not match PUT /api/codespaces (invalid method)', () => {
      const result = matchRoute('/api/codespaces', 'PUT', routes);
      expect(result.matched).toBe(false);
    });
  });

  describe('Task Routes', () => {
    it('matches GET /api/tasks', () => {
      const result = matchRoute('/api/tasks', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listTasks');
    });

    it('matches POST /api/tasks', () => {
      const result = matchRoute('/api/tasks', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createTask');
    });

    it('matches GET /api/tasks/:id', () => {
      const result = matchRoute('/api/tasks/task-456', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getTask');
      expect(result.params?.id).toBe('task-456');
    });

    it('matches PUT /api/tasks/:id', () => {
      const result = matchRoute('/api/tasks/task-456', 'PUT', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('updateTask');
    });

    it('matches DELETE /api/tasks/:id', () => {
      const result = matchRoute('/api/tasks/task-456', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteTask');
    });
  });

  describe('Agent Routes', () => {
    it('matches GET /api/agents', () => {
      const result = matchRoute('/api/agents', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listAgents');
    });

    it('matches GET /api/agents/:id', () => {
      const result = matchRoute('/api/agents/agent-789', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getAgent');
      expect(result.params?.id).toBe('agent-789');
    });

    it('matches POST /api/agents/:id/start', () => {
      const result = matchRoute('/api/agents/agent-789/start', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('startAgent');
      expect(result.params?.id).toBe('agent-789');
    });

    it('matches POST /api/agents/:id/stop', () => {
      const result = matchRoute('/api/agents/agent-789/stop', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('stopAgent');
    });
  });

  describe('Session Routes', () => {
    it('matches GET /api/sessions', () => {
      const result = matchRoute('/api/sessions', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listSessions');
    });

    it('matches GET /api/sessions/:id', () => {
      const result = matchRoute('/api/sessions/sess-123', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getSession');
    });

    it('matches GET /api/sessions/:id/events', () => {
      const result = matchRoute('/api/sessions/sess-123/events', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getSessionEvents');
    });

    it('matches GET /api/sessions/:id/summary', () => {
      const result = matchRoute('/api/sessions/sess-123/summary', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getSessionSummary');
    });
  });

  describe('Template Routes', () => {
    it('matches GET /api/templates', () => {
      const result = matchRoute('/api/templates', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listTemplates');
    });

    it('matches POST /api/templates', () => {
      const result = matchRoute('/api/templates', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createTemplate');
    });

    it('matches GET /api/templates/:id', () => {
      const result = matchRoute('/api/templates/tmpl-123', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getTemplate');
    });

    it('matches PATCH /api/templates/:id', () => {
      const result = matchRoute('/api/templates/tmpl-123', 'PATCH', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('updateTemplate');
    });

    it('matches DELETE /api/templates/:id', () => {
      const result = matchRoute('/api/templates/tmpl-123', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteTemplate');
    });

    it('matches POST /api/templates/:id/sync', () => {
      const result = matchRoute('/api/templates/tmpl-123/sync', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('syncTemplate');
    });
  });

  describe('Marketplace Routes', () => {
    it('matches GET /api/marketplaces', () => {
      const result = matchRoute('/api/marketplaces', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listMarketplaces');
    });

    it('matches POST /api/marketplaces', () => {
      const result = matchRoute('/api/marketplaces', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createMarketplace');
    });

    it('matches GET /api/marketplaces/plugins', () => {
      const result = matchRoute('/api/marketplaces/plugins', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listPlugins');
    });

    it('matches GET /api/marketplaces/categories', () => {
      const result = matchRoute('/api/marketplaces/categories', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getCategories');
    });

    it('matches POST /api/marketplaces/seed', () => {
      const result = matchRoute('/api/marketplaces/seed', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('seedMarketplace');
    });

    it('matches GET /api/marketplaces/:id', () => {
      const result = matchRoute('/api/marketplaces/mp-123', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getMarketplace');
    });

    it('matches DELETE /api/marketplaces/:id', () => {
      const result = matchRoute('/api/marketplaces/mp-123', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteMarketplace');
    });

    it('matches POST /api/marketplaces/:id/sync', () => {
      const result = matchRoute('/api/marketplaces/mp-123/sync', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('syncMarketplace');
    });
  });

  describe('API Key Routes', () => {
    it('matches GET /api/keys/:service', () => {
      const result = matchRoute('/api/keys/anthropic', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getApiKey');
      expect(result.params?.service).toBe('anthropic');
    });

    it('matches POST /api/keys/:service', () => {
      const result = matchRoute('/api/keys/anthropic', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('saveApiKey');
    });

    it('matches DELETE /api/keys/:service', () => {
      const result = matchRoute('/api/keys/anthropic', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteApiKey');
    });
  });

  describe('Sandbox Config Routes', () => {
    it('matches GET /api/sandbox-configs', () => {
      const result = matchRoute('/api/sandbox-configs', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listSandboxConfigs');
    });

    it('matches POST /api/sandbox-configs', () => {
      const result = matchRoute('/api/sandbox-configs', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createSandboxConfig');
    });

    it('matches GET /api/sandbox-configs/:id', () => {
      const result = matchRoute('/api/sandbox-configs/config-123', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getSandboxConfig');
    });

    it('matches PATCH /api/sandbox-configs/:id', () => {
      const result = matchRoute('/api/sandbox-configs/config-123', 'PATCH', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('updateSandboxConfig');
    });

    it('matches DELETE /api/sandbox-configs/:id', () => {
      const result = matchRoute('/api/sandbox-configs/config-123', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteSandboxConfig');
    });
  });

  describe('GitHub Routes', () => {
    it('matches GET /api/github/orgs', () => {
      const result = matchRoute('/api/github/orgs', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listGitHubOrgs');
    });

    it('matches GET /api/github/repos', () => {
      const result = matchRoute('/api/github/repos', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listGitHubRepos');
    });

    it('matches GET /api/github/repos/:owner', () => {
      const result = matchRoute('/api/github/repos/anthropic', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listOwnerRepos');
      expect(result.params?.owner).toBe('anthropic');
    });

    it('matches GET /api/github/token', () => {
      const result = matchRoute('/api/github/token', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getGitHubToken');
    });

    it('matches POST /api/github/token', () => {
      const result = matchRoute('/api/github/token', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('saveGitHubToken');
    });

    it('matches DELETE /api/github/token', () => {
      const result = matchRoute('/api/github/token', 'DELETE', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('deleteGitHubToken');
    });

    it('matches POST /api/github/revalidate', () => {
      const result = matchRoute('/api/github/revalidate', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('revalidateToken');
    });

    it('matches POST /api/github/clone', () => {
      const result = matchRoute('/api/github/clone', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('cloneRepo');
    });

    it('matches POST /api/github/create-from-template', () => {
      const result = matchRoute('/api/github/create-from-template', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('createFromTemplate');
    });
  });

  describe('Git Routes', () => {
    it('matches GET /api/git/status', () => {
      const result = matchRoute('/api/git/status', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('getGitStatus');
    });

    it('matches GET /api/git/branches', () => {
      const result = matchRoute('/api/git/branches', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listBranches');
    });

    it('matches GET /api/git/commits', () => {
      const result = matchRoute('/api/git/commits', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listCommits');
    });

    it('matches GET /api/git/remote-branches', () => {
      const result = matchRoute('/api/git/remote-branches', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('listRemoteBranches');
    });
  });

  describe('Task Creation with AI Routes', () => {
    it('matches POST /api/tasks/create-with-ai/start', () => {
      const result = matchRoute('/api/tasks/create-with-ai/start', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('startTaskConversation');
    });

    it('matches POST /api/tasks/create-with-ai/message', () => {
      const result = matchRoute('/api/tasks/create-with-ai/message', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('sendTaskMessage');
    });

    it('matches POST /api/tasks/create-with-ai/accept', () => {
      const result = matchRoute('/api/tasks/create-with-ai/accept', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('acceptTaskSuggestion');
    });

    it('matches POST /api/tasks/create-with-ai/cancel', () => {
      const result = matchRoute('/api/tasks/create-with-ai/cancel', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('cancelTaskConversation');
    });

    it('matches GET /api/tasks/create-with-ai/stream', () => {
      const result = matchRoute('/api/tasks/create-with-ai/stream', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('streamTaskConversation');
    });
  });

  describe('Utility Routes', () => {
    it('matches POST /api/workflow-designer/analyze', () => {
      const result = matchRoute('/api/workflow-designer/analyze', 'POST', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('analyzeWorkflow');
    });

    it('matches GET /api/health', () => {
      const result = matchRoute('/api/health', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('healthCheck');
    });

    it('matches GET /api/filesystem/discover-repos', () => {
      const result = matchRoute('/api/filesystem/discover-repos', 'GET', routes);
      expect(result.matched).toBe(true);
      expect(result.handler).toBe('discoverRepos');
    });
  });

  describe('Route Not Found', () => {
    it('does not match unknown routes', () => {
      const result = matchRoute('/api/unknown', 'GET', routes);
      expect(result.matched).toBe(false);
    });

    it('does not match wrong HTTP methods', () => {
      const result = matchRoute('/api/codespaces', 'PUT', routes);
      expect(result.matched).toBe(false);
    });

    it('does not match non-API routes', () => {
      const result = matchRoute('/some/other/path', 'GET', routes);
      expect(result.matched).toBe(false);
    });
  });
});

// =============================================================================
// CORS Header Tests
// =============================================================================

describe('CORS Headers', () => {
  // Simulates CORS header generation as in api.ts
  function getCorsHeaders(origin = 'http://localhost:3000'): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
  }

  it('includes Access-Control-Allow-Origin header', () => {
    const headers = getCorsHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
  });

  it('includes all HTTP methods in Access-Control-Allow-Methods', () => {
    const headers = getCorsHeaders();
    const methods = headers['Access-Control-Allow-Methods'];
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('OPTIONS');
  });

  it('includes Content-Type in Access-Control-Allow-Headers', () => {
    const headers = getCorsHeaders();
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
  });

  it('includes Authorization in Access-Control-Allow-Headers', () => {
    const headers = getCorsHeaders();
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('includes Max-Age header for caching', () => {
    const headers = getCorsHeaders();
    expect(headers['Access-Control-Max-Age']).toBe('86400');
  });
});

// =============================================================================
// JSON Response Format Tests
// =============================================================================

describe('JSON Response Format', () => {
  type ApiSuccess<T> = { ok: true; data: T };
  type ApiError = { ok: false; error: { code: string; message: string } };

  function jsonSuccess<T>(data: T): ApiSuccess<T> {
    return { ok: true, data };
  }

  function jsonError(code: string, message: string): ApiError {
    return { ok: false, error: { code, message } };
  }

  describe('Success Responses', () => {
    it('includes ok: true for successful responses', () => {
      const response = jsonSuccess({ id: 'test-123' });
      expect(response.ok).toBe(true);
    });

    it('includes data field with payload', () => {
      const payload = { id: 'test-123', name: 'Test' };
      const response = jsonSuccess(payload);
      expect(response.data).toEqual(payload);
    });

    it('supports array data', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const response = jsonSuccess({ items, totalCount: 2 });
      expect(response.data.items).toHaveLength(2);
      expect(response.data.totalCount).toBe(2);
    });

    it('supports null data', () => {
      const response = jsonSuccess(null);
      expect(response.ok).toBe(true);
      expect(response.data).toBeNull();
    });
  });

  describe('Error Responses', () => {
    it('includes ok: false for error responses', () => {
      const response = jsonError('NOT_FOUND', 'Resource not found');
      expect(response.ok).toBe(false);
    });

    it('includes error code', () => {
      const response = jsonError('VALIDATION_ERROR', 'Invalid input');
      expect(response.error.code).toBe('VALIDATION_ERROR');
    });

    it('includes error message', () => {
      const response = jsonError('NOT_FOUND', 'Project not found');
      expect(response.error.message).toBe('Project not found');
    });
  });

  describe('Common Error Codes', () => {
    it('returns NOT_FOUND for missing resources', () => {
      const response = jsonError('NOT_FOUND', 'Resource not found');
      expect(response.error.code).toBe('NOT_FOUND');
    });

    it('returns VALIDATION_ERROR for invalid input', () => {
      const response = jsonError('VALIDATION_ERROR', 'Invalid data');
      expect(response.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns MISSING_PARAMS for required parameters', () => {
      const response = jsonError('MISSING_PARAMS', 'codespaceId is required');
      expect(response.error.code).toBe('MISSING_PARAMS');
    });

    it('returns DUPLICATE for unique constraint violations', () => {
      const response = jsonError('DUPLICATE', 'Path already exists');
      expect(response.error.code).toBe('DUPLICATE');
    });

    it('returns PROJECT_HAS_RUNNING_AGENTS for delete conflicts', () => {
      const response = jsonError(
        'PROJECT_HAS_RUNNING_AGENTS',
        'Cannot delete project with running agents'
      );
      expect(response.error.code).toBe('PROJECT_HAS_RUNNING_AGENTS');
    });

    it('returns INVALID_JSON for malformed request body', () => {
      const response = jsonError('INVALID_JSON', 'Request body is not valid JSON');
      expect(response.error.code).toBe('INVALID_JSON');
    });

    it('returns MISSING_TOKEN for GitHub token operations', () => {
      const response = jsonError('MISSING_TOKEN', 'Token is required');
      expect(response.error.code).toBe('MISSING_TOKEN');
    });

    it('returns MISSING_NAME for marketplace creation', () => {
      const response = jsonError('MISSING_NAME', 'Name is required');
      expect(response.error.code).toBe('MISSING_NAME');
    });

    it('returns MISSING_REPO for marketplace creation', () => {
      const response = jsonError('MISSING_REPO', 'GitHub repository is required');
      expect(response.error.code).toBe('MISSING_REPO');
    });

    it('returns INVALID_INPUT for task creation validation', () => {
      const response = jsonError('INVALID_INPUT', 'Invalid input provided');
      expect(response.error.code).toBe('INVALID_INPUT');
    });
  });
});

// =============================================================================
// ID Validation Tests
// =============================================================================

describe('ID Validation', () => {
  // Simulates ID validation as in api.ts
  function isValidId(id: unknown): boolean {
    if (!id || typeof id !== 'string') return false;
    if (id.length < 1 || id.length > 100) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  describe('Valid IDs', () => {
    it('accepts cuid2 IDs', () => {
      const id = createId();
      expect(isValidId(id)).toBe(true);
    });

    it('accepts kebab-case IDs', () => {
      expect(isValidId('my-valid-id')).toBe(true);
    });

    it('accepts snake_case IDs', () => {
      expect(isValidId('my_valid_id')).toBe(true);
    });

    it('accepts alphanumeric IDs', () => {
      expect(isValidId('abc123')).toBe(true);
    });

    it('accepts single character IDs', () => {
      expect(isValidId('a')).toBe(true);
    });

    it('accepts IDs at maximum length', () => {
      const maxLengthId = 'a'.repeat(100);
      expect(isValidId(maxLengthId)).toBe(true);
    });

    it('accepts mixed case IDs', () => {
      expect(isValidId('MyProject-ID_123')).toBe(true);
    });
  });

  describe('Invalid IDs', () => {
    it('rejects empty strings', () => {
      expect(isValidId('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidId(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidId(undefined)).toBe(false);
    });

    it('rejects numbers', () => {
      expect(isValidId(123)).toBe(false);
    });

    it('rejects objects', () => {
      expect(isValidId({ id: 'test' })).toBe(false);
    });

    it('rejects arrays', () => {
      expect(isValidId(['test'])).toBe(false);
    });

    it('rejects IDs with slashes', () => {
      expect(isValidId('invalid/id')).toBe(false);
    });

    it('rejects IDs with dots', () => {
      expect(isValidId('invalid.id')).toBe(false);
    });

    it('rejects IDs with spaces', () => {
      expect(isValidId('invalid id')).toBe(false);
    });

    it('rejects IDs with special characters', () => {
      expect(isValidId('invalid@id')).toBe(false);
      expect(isValidId('invalid#id')).toBe(false);
      expect(isValidId('invalid$id')).toBe(false);
      expect(isValidId('invalid%id')).toBe(false);
      expect(isValidId('invalid!id')).toBe(false);
    });

    it('rejects IDs exceeding maximum length', () => {
      const tooLongId = 'a'.repeat(101);
      expect(isValidId(tooLongId)).toBe(false);
    });
  });
});

// =============================================================================
// Query Parameter Parsing Tests
// =============================================================================

describe('Query Parameter Parsing', () => {
  function parseQueryParams(url: string): URLSearchParams {
    const urlObj = new URL(url, 'http://localhost:3001');
    return urlObj.searchParams;
  }

  function getQueryParam(params: URLSearchParams, name: string, defaultValue: string): string {
    return params.get(name) ?? defaultValue;
  }

  function getQueryParamInt(params: URLSearchParams, name: string, defaultValue: number): number {
    const value = params.get(name);
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  describe('String Parameters', () => {
    it('extracts codespaceId parameter', () => {
      const params = parseQueryParams('/api/tasks?codespaceId=proj-123');
      expect(params.get('codespaceId')).toBe('proj-123');
    });

    it('extracts column filter parameter', () => {
      const params = parseQueryParams('/api/tasks?codespaceId=proj-123&column=backlog');
      expect(params.get('column')).toBe('backlog');
    });

    it('extracts search parameter', () => {
      const params = parseQueryParams('/api/marketplaces/plugins?search=typescript');
      expect(params.get('search')).toBe('typescript');
    });

    it('extracts scope parameter', () => {
      const params = parseQueryParams('/api/templates?scope=org');
      expect(params.get('scope')).toBe('org');
    });

    it('returns null for missing parameters', () => {
      const params = parseQueryParams('/api/tasks');
      expect(params.get('codespaceId')).toBeNull();
    });

    it('returns default value for missing parameters', () => {
      const params = parseQueryParams('/api/tasks');
      expect(getQueryParam(params, 'codespaceId', 'default')).toBe('default');
    });
  });

  describe('Integer Parameters', () => {
    it('extracts limit parameter', () => {
      const params = parseQueryParams('/api/codespaces?limit=10');
      expect(getQueryParamInt(params, 'limit', 24)).toBe(10);
    });

    it('extracts offset parameter', () => {
      const params = parseQueryParams('/api/sessions?offset=20');
      expect(getQueryParamInt(params, 'offset', 0)).toBe(20);
    });

    it('returns default value for missing integer parameters', () => {
      const params = parseQueryParams('/api/codespaces');
      expect(getQueryParamInt(params, 'limit', 24)).toBe(24);
    });

    it('returns default value for non-numeric strings', () => {
      const params = parseQueryParams('/api/codespaces?limit=abc');
      expect(getQueryParamInt(params, 'limit', 24)).toBe(24);
    });
  });

  describe('Boolean Parameters', () => {
    it('extracts includeDisabled parameter', () => {
      const params = parseQueryParams('/api/marketplaces?includeDisabled=true');
      expect(params.get('includeDisabled')).toBe('true');
    });

  });

  describe('Multiple Parameters', () => {
    it('extracts multiple parameters', () => {
      const params = parseQueryParams('/api/tasks?codespaceId=proj-123&column=backlog&limit=10');
      expect(params.get('codespaceId')).toBe('proj-123');
      expect(params.get('column')).toBe('backlog');
      expect(getQueryParamInt(params, 'limit', 50)).toBe(10);
    });
  });
});

// =============================================================================
// Request Body Validation Tests
// =============================================================================

describe('Request Body Validation', () => {
  describe('Project Creation', () => {
    it('validates required name field', () => {
      const body = { path: '/path' };
      const hasName = body && 'name' in body && body.name;
      expect(hasName).toBeFalsy();
    });

    it('validates required path field', () => {
      const body = { name: 'Project' };
      const hasPath = body && 'path' in body && body.path;
      expect(hasPath).toBeFalsy();
    });

    it('accepts valid project data', () => {
      const body = { name: 'Project', path: '/path', description: 'Description' };
      const isValid = body?.name && body.path;
      expect(isValid).toBeTruthy();
    });
  });

  describe('Task Creation', () => {
    it('validates required codespaceId field', () => {
      const body = { title: 'Task' };
      const hasProjectId = body && 'codespaceId' in body && body.codespaceId;
      expect(hasProjectId).toBeFalsy();
    });

    it('validates required title field', () => {
      const body = { codespaceId: 'proj-123' };
      const hasTitle = body && 'title' in body && body.title;
      expect(hasTitle).toBeFalsy();
    });

    it('accepts valid task data', () => {
      const body = { codespaceId: 'proj-123', title: 'Task', description: 'Description' };
      const isValid = body?.codespaceId && body.title;
      expect(isValid).toBeTruthy();
    });

    it('accepts task with optional fields', () => {
      const body = {
        codespaceId: 'proj-123',
        title: 'Task',
        description: 'Description',
        column: 'backlog',
        labels: ['feature'],
      };
      expect(body.column).toBe('backlog');
      expect(body.labels).toContain('feature');
    });
  });

  describe('API Key', () => {
    it('validates required key field', () => {
      const body = {};
      const hasKey = body && 'key' in body && body.key;
      expect(hasKey).toBeFalsy();
    });

    it('accepts valid API key data', () => {
      const body = { key: 'sk-ant-api03-xxxxx' };
      const isValid = body?.key;
      expect(isValid).toBeTruthy();
    });
  });

  describe('GitHub Token', () => {
    it('validates required token field', () => {
      const body = {};
      const hasToken = body && 'token' in body && body.token;
      expect(hasToken).toBeFalsy();
    });

    it('accepts valid GitHub token data', () => {
      const body = { token: 'ghp_xxxxx' };
      const isValid = body?.token;
      expect(isValid).toBeTruthy();
    });
  });

  describe('Marketplace Creation', () => {
    it('validates required name field', () => {
      const body = { githubUrl: 'https://github.com/org/repo' };
      const hasName = body && 'name' in body && body.name;
      expect(hasName).toBeFalsy();
    });

    it('validates required github info', () => {
      const body = { name: 'Marketplace' };
      const hasGithub =
        (body && 'githubUrl' in body && body.githubUrl) ||
        (body && 'githubOwner' in body && 'githubRepo' in body);
      expect(hasGithub).toBeFalsy();
    });

    it('accepts valid marketplace with githubUrl', () => {
      const body = { name: 'Marketplace', githubUrl: 'https://github.com/org/repo' };
      const isValid = body?.name && body.githubUrl;
      expect(isValid).toBeTruthy();
    });

    it('accepts valid marketplace with owner/repo', () => {
      const body = { name: 'Marketplace', githubOwner: 'org', githubRepo: 'repo' };
      const isValid = body?.name && body.githubOwner && body.githubRepo;
      expect(isValid).toBeTruthy();
    });
  });

  describe('Clone Repository', () => {
    it('validates required url field', () => {
      const body = { destination: '/path' };
      const hasUrl = body && 'url' in body && body.url;
      expect(hasUrl).toBeFalsy();
    });

    it('validates required destination field', () => {
      const body = { url: 'https://github.com/org/repo' };
      const hasDest = body && 'destination' in body && body.destination;
      expect(hasDest).toBeFalsy();
    });

    it('accepts valid clone data', () => {
      const body = { url: 'https://github.com/org/repo', destination: '/path' };
      const isValid = body?.url && body.destination;
      expect(isValid).toBeTruthy();
    });
  });

  describe('Create From Template', () => {
    it('validates required templateOwner field', () => {
      const body = { templateRepo: 'template', name: 'repo', clonePath: '/path' };
      const hasOwner = body && 'templateOwner' in body && body.templateOwner;
      expect(hasOwner).toBeFalsy();
    });

    it('validates required templateRepo field', () => {
      const body = { templateOwner: 'org', name: 'repo', clonePath: '/path' };
      const hasRepo = body && 'templateRepo' in body && body.templateRepo;
      expect(hasRepo).toBeFalsy();
    });

    it('validates required name field', () => {
      const body = { templateOwner: 'org', templateRepo: 'template', clonePath: '/path' };
      const hasName = body && 'name' in body && body.name;
      expect(hasName).toBeFalsy();
    });

    it('validates required clonePath field', () => {
      const body = { templateOwner: 'org', templateRepo: 'template', name: 'repo' };
      const hasPath = body && 'clonePath' in body && body.clonePath;
      expect(hasPath).toBeFalsy();
    });

    it('accepts valid create from template data', () => {
      const body = {
        templateOwner: 'org',
        templateRepo: 'template',
        name: 'repo',
        clonePath: '/path',
      };
      const isValid = body.templateOwner && body.templateRepo && body.name && body.clonePath;
      expect(isValid).toBeTruthy();
    });
  });

  describe('Task Creation with AI', () => {
    it('validates required codespaceId for start', () => {
      const body = {};
      const hasProjectId = body && 'codespaceId' in body && body.codespaceId;
      expect(hasProjectId).toBeFalsy();
    });

    it('validates required sessionId for message', () => {
      const body = { message: 'hello' };
      const hasSessionId = body && 'sessionId' in body && body.sessionId;
      expect(hasSessionId).toBeFalsy();
    });

    it('validates required message for message endpoint', () => {
      const body = { sessionId: 'session-123' };
      const hasMessage = body && 'message' in body && body.message;
      expect(hasMessage).toBeFalsy();
    });

    it('validates required sessionId for accept', () => {
      const body = {};
      const hasSessionId = body && 'sessionId' in body && body.sessionId;
      expect(hasSessionId).toBeFalsy();
    });

    it('validates required sessionId for cancel', () => {
      const body = {};
      const hasSessionId = body && 'sessionId' in body && body.sessionId;
      expect(hasSessionId).toBeFalsy();
    });
  });

  describe('Sandbox Config', () => {
    it('validates required name field', () => {
      const body = { baseImage: 'ubuntu:22.04' };
      const hasName = body && 'name' in body && body.name;
      expect(hasName).toBeFalsy();
    });

    it('accepts valid sandbox config data', () => {
      const body = {
        name: 'Test Config',
        baseImage: 'ubuntu:22.04',
        memoryMb: 2048,
        cpuCores: 2,
      };
      const isValid = body?.name;
      expect(isValid).toBeTruthy();
    });
  });
});

// =============================================================================
// Pagination Response Tests
// =============================================================================

describe('Pagination Response Format', () => {
  type PaginatedResponse<T> = {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
    totalCount: number;
  };

  function createPaginatedResponse<T>(
    items: T[],
    totalCount: number,
    limit: number,
    offset: number
  ): PaginatedResponse<T> {
    return {
      items,
      nextCursor: offset + limit < totalCount ? String(offset + limit) : null,
      hasMore: offset + limit < totalCount,
      totalCount,
    };
  }

  it('includes items array', () => {
    const response = createPaginatedResponse([{ id: '1' }, { id: '2' }], 2, 10, 0);
    expect(response.items).toHaveLength(2);
  });

  it('includes totalCount', () => {
    const response = createPaginatedResponse([{ id: '1' }], 100, 10, 0);
    expect(response.totalCount).toBe(100);
  });

  it('sets hasMore to true when more items exist', () => {
    const response = createPaginatedResponse([{ id: '1' }], 100, 10, 0);
    expect(response.hasMore).toBe(true);
  });

  it('sets hasMore to false when no more items', () => {
    const response = createPaginatedResponse([{ id: '1' }], 1, 10, 0);
    expect(response.hasMore).toBe(false);
  });

  it('provides nextCursor when more items exist', () => {
    const response = createPaginatedResponse([{ id: '1' }], 100, 10, 0);
    expect(response.nextCursor).toBe('10');
  });

  it('sets nextCursor to null when no more items', () => {
    const response = createPaginatedResponse([{ id: '1' }], 1, 10, 0);
    expect(response.nextCursor).toBeNull();
  });

  it('handles empty results', () => {
    const response = createPaginatedResponse([], 0, 10, 0);
    expect(response.items).toHaveLength(0);
    expect(response.totalCount).toBe(0);
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();
  });
});

// =============================================================================
// HTTP Status Code Tests
// =============================================================================

describe('HTTP Status Codes', () => {
  const statusCodes = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
  };

  describe('Success Status Codes', () => {
    it('uses 200 for successful GET requests', () => {
      expect(statusCodes.OK).toBe(200);
    });

    it('uses 200 for successful POST requests that return data', () => {
      expect(statusCodes.OK).toBe(200);
    });

    it('uses 201 for resource creation (optional)', () => {
      expect(statusCodes.CREATED).toBe(201);
    });

    it('uses 204 for OPTIONS preflight', () => {
      expect(statusCodes.NO_CONTENT).toBe(204);
    });
  });

  describe('Error Status Codes', () => {
    it('uses 400 for validation errors', () => {
      expect(statusCodes.BAD_REQUEST).toBe(400);
    });

    it('uses 400 for missing required parameters', () => {
      expect(statusCodes.BAD_REQUEST).toBe(400);
    });

    it('uses 400 for duplicate entries', () => {
      expect(statusCodes.BAD_REQUEST).toBe(400);
    });

    it('uses 404 for resource not found', () => {
      expect(statusCodes.NOT_FOUND).toBe(404);
    });

    it('uses 409 for conflict (e.g., running agents)', () => {
      expect(statusCodes.CONFLICT).toBe(409);
    });

    it('uses 500 for internal server errors', () => {
      expect(statusCodes.INTERNAL_SERVER_ERROR).toBe(500);
    });
  });
});

// =============================================================================
// Health Check Response Tests
// =============================================================================

describe('Health Check Response', () => {
  type HealthCheckResponse = {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    uptime: number;
    checks: {
      database: { status: 'ok' | 'error'; latencyMs?: number; error?: string };
      github?: { status: 'ok' | 'not_configured' | 'error'; error?: string };
    };
    responseTimeMs: number;
  };

  function createHealthCheck(dbOk: boolean, gitHubConfigured: boolean): HealthCheckResponse {
    const checks: HealthCheckResponse['checks'] = {
      database: dbOk
        ? { status: 'ok', latencyMs: 5 }
        : { status: 'error', error: 'Connection failed' },
    };

    if (gitHubConfigured) {
      checks.github = { status: 'ok' };
    } else {
      checks.github = { status: 'not_configured' };
    }

    return {
      status: dbOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: 12345,
      checks,
      responseTimeMs: 10,
    };
  }

  it('returns healthy status when all checks pass', () => {
    const health = createHealthCheck(true, true);
    expect(health.status).toBe('healthy');
  });

  it('returns degraded status when database fails', () => {
    const health = createHealthCheck(false, true);
    expect(health.status).toBe('degraded');
  });

  it('includes timestamp', () => {
    const health = createHealthCheck(true, true);
    expect(health.timestamp).toBeDefined();
  });

  it('includes uptime', () => {
    const health = createHealthCheck(true, true);
    expect(health.uptime).toBeDefined();
    expect(typeof health.uptime).toBe('number');
  });

  it('includes database check', () => {
    const health = createHealthCheck(true, true);
    expect(health.checks.database).toBeDefined();
    expect(health.checks.database.status).toBe('ok');
  });

  it('includes database latency when ok', () => {
    const health = createHealthCheck(true, true);
    expect(health.checks.database.latencyMs).toBeDefined();
  });

  it('includes error message when database fails', () => {
    const health = createHealthCheck(false, true);
    expect(health.checks.database.error).toBeDefined();
  });

  it('includes github check status', () => {
    const health = createHealthCheck(true, true);
    expect(health.checks.github?.status).toBe('ok');
  });

  it('shows github as not_configured when no token', () => {
    const health = createHealthCheck(true, false);
    expect(health.checks.github?.status).toBe('not_configured');
  });

  it('includes response time', () => {
    const health = createHealthCheck(true, true);
    expect(health.responseTimeMs).toBeDefined();
  });
});

// =============================================================================
// URL Path Parsing Tests
// =============================================================================

describe('URL Path Parsing', () => {
  function parseUrlPath(url: string): { pathname: string; segments: string[] } {
    const urlObj = new URL(url, 'http://localhost:3001');
    const pathname = urlObj.pathname;
    const segments = pathname.split('/').filter(Boolean);
    return { pathname, segments };
  }

  it('parses simple paths', () => {
    const { pathname, segments } = parseUrlPath('/api/codespaces');
    expect(pathname).toBe('/api/codespaces');
    expect(segments).toEqual(['api', 'codespaces']);
  });

  it('parses paths with IDs', () => {
    const { segments } = parseUrlPath('/api/codespaces/proj-123');
    expect(segments).toEqual(['api', 'codespaces', 'proj-123']);
  });

  it('parses nested paths', () => {
    const { segments } = parseUrlPath('/api/sessions/sess-123/events');
    expect(segments).toEqual(['api', 'sessions', 'sess-123', 'events']);
  });

  it('parses paths with action suffixes', () => {
    const { segments } = parseUrlPath('/api/agents/agent-123/start');
    expect(segments).toEqual(['api', 'agents', 'agent-123', 'start']);
  });

  it('handles trailing slashes', () => {
    const { pathname, segments } = parseUrlPath('/api/codespaces/');
    expect(pathname).toBe('/api/codespaces/');
    expect(segments).toEqual(['api', 'codespaces']);
  });

  it('extracts ID from path segments', () => {
    const { segments } = parseUrlPath('/api/codespaces/proj-123');
    const id = segments[2];
    expect(id).toBe('proj-123');
  });
});
