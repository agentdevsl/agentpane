import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for Workflow Designer routes.
 *
 * The /analyze endpoint calls Claude Agent SDK and ELK layout.
 * We mock both external dependencies and test the route validation,
 * error handling, and response shaping.
 */

// Mock the Agent SDK
vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  agentQuery: vi.fn(),
}));

// Mock the ELK layout
vi.mock('../../src/lib/workflow-dsl/layout.js', () => ({
  layoutWorkflow: vi.fn(),
  findChainHeadAndTail: vi.fn(),
}));

import { agentQuery } from '../../src/lib/agents/agent-sdk-utils';
import { err, ok } from '../../src/lib/utils/result';
import { layoutWorkflow } from '../../src/lib/workflow-dsl/layout';
import { createWorkflowDesignerRoutes } from '../../src/server/routes/workflow-designer';

const mockAgentQuery = vi.mocked(agentQuery);
const mockLayoutWorkflow = vi.mocked(layoutWorkflow);

function createMockTemplateService() {
  return {
    getById: vi.fn().mockResolvedValue(
      ok({
        name: 'Test Template',
        description: 'A test template',
        cachedSkills: [
          { id: 'skill-1', name: 'Test Skill', description: 'desc', content: 'content' },
        ],
        cachedCommands: [],
        cachedAgents: [],
      })
    ),
  };
}

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Workflow Designer Routes (IT-650)', () => {
  let app: ReturnType<typeof createWorkflowDesignerRoutes>;
  let templateService: ReturnType<typeof createMockTemplateService>;

  beforeEach(() => {
    vi.clearAllMocks();
    templateService = createMockTemplateService();
    app = createWorkflowDesignerRoutes({
      templateService: templateService as any,
    });

    // Default: layout returns nodes with positions
    mockLayoutWorkflow.mockImplementation(async (nodes) => {
      return nodes.map((n, i) => ({
        ...n,
        position: { x: 0, y: i * 100 },
      }));
    });
  });

  // ─── POST /analyze ────────────────────────────

  describe('POST /analyze', () => {
    it('IT-651: returns 400 for invalid JSON', async () => {
      const response = await app.request(
        new Request('http://localhost/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_JSON');
    });

    it('IT-652: returns 400 when no content source provided', async () => {
      const response = await app.request(jsonRequest('http://localhost/analyze', {}));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-653: returns 404 when template not found', async () => {
      templateService.getById.mockResolvedValue(
        err({ code: 'NOT_FOUND', message: 'Template not found', status: 404 })
      );

      const response = await app.request(
        jsonRequest('http://localhost/analyze', { templateId: 'nonexistent' })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('IT-654: returns 400 when template has no content', async () => {
      templateService.getById.mockResolvedValue(
        ok({
          name: 'Empty Template',
          cachedSkills: [],
          cachedCommands: [],
          cachedAgents: [],
        })
      );

      const response = await app.request(
        jsonRequest('http://localhost/analyze', { templateId: 'tmpl-empty' })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('WORKFLOW_NO_CONTENT');
    });

    it('IT-655: generates workflow from inline skills', async () => {
      const aiResponse = JSON.stringify({
        nodes: [
          { id: 'start-1', type: 'start', label: 'Start', position: { x: 0, y: 0 }, inputs: [] },
          {
            id: 'step-1',
            type: 'action',
            label: 'Run Skill',
            position: { x: 0, y: 100 },
            skillId: 'skill-1',
          },
          { id: 'end-1', type: 'end', label: 'End', position: { x: 0, y: 200 }, outputs: [] },
        ],
        edges: [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start-1', targetNodeId: 'step-1' },
          { id: 'e2', type: 'sequential', sourceNodeId: 'step-1', targetNodeId: 'end-1' },
        ],
        aiGenerated: true,
        aiConfidence: 0.85,
      });

      mockAgentQuery.mockResolvedValue({ text: aiResponse } as any);

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [
            { id: 'skill-1', name: 'Deploy', description: 'Deploy app', content: 'deploy steps' },
          ],
          name: 'Deploy Workflow',
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.workflow).toBeDefined();
      expect(body.data.workflow.name).toBe('Deploy Workflow');
      expect(body.data.workflow.nodes.length).toBeGreaterThan(0);
      expect(body.data.workflow.aiGenerated).toBe(true);
    });

    it('IT-656: returns 500 when AI returns empty response', async () => {
      mockAgentQuery.mockResolvedValue({ text: '' } as any);

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [{ id: 'skill-1', name: 'Test', description: 'test', content: 'content' }],
        })
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('WORKFLOW_AI_GENERATION_FAILED');
    });

    it('IT-657: returns 401 when API key is missing', async () => {
      mockAgentQuery.mockRejectedValue(new Error('401 authentication_error'));

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [{ id: 'skill-1', name: 'Test', description: 'test', content: 'content' }],
        })
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('WORKFLOW_API_KEY_NOT_FOUND');
    });

    it('IT-658: returns 422 when AI returns invalid JSON', async () => {
      mockAgentQuery.mockResolvedValue({ text: 'This is not JSON at all' } as any);

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [{ id: 'skill-1', name: 'Test', description: 'test', content: 'content' }],
        })
      );

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe('WORKFLOW_INVALID_AI_RESPONSE');
    });

    it('IT-659: handles AI response wrapped in markdown code block', async () => {
      const aiResponse =
        '```json\n' +
        JSON.stringify({
          nodes: [
            { id: 'start-1', type: 'start', label: 'Start', position: { x: 0, y: 0 }, inputs: [] },
            { id: 'step-1', type: 'action', label: 'Do Thing', position: { x: 0, y: 100 } },
            { id: 'end-1', type: 'end', label: 'End', position: { x: 0, y: 200 }, outputs: [] },
          ],
          edges: [
            { id: 'e1', type: 'sequential', sourceNodeId: 'start-1', targetNodeId: 'step-1' },
            { id: 'e2', type: 'sequential', sourceNodeId: 'step-1', targetNodeId: 'end-1' },
          ],
          aiGenerated: true,
          aiConfidence: 0.75,
        }) +
        '\n```';

      mockAgentQuery.mockResolvedValue({ text: aiResponse } as any);

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [{ id: 'skill-1', name: 'Test', description: 'test', content: 'content' }],
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.workflow.nodes.length).toBeGreaterThan(0);
    });

    it('IT-660: returns 500 when layout engine fails', async () => {
      const aiResponse = JSON.stringify({
        nodes: [
          { id: 'start-1', type: 'start', label: 'Start', position: { x: 0, y: 0 }, inputs: [] },
          { id: 'end-1', type: 'end', label: 'End', position: { x: 0, y: 100 }, outputs: [] },
        ],
        edges: [{ id: 'e1', type: 'sequential', sourceNodeId: 'start-1', targetNodeId: 'end-1' }],
        aiGenerated: true,
      });

      mockAgentQuery.mockResolvedValue({ text: aiResponse } as any);
      mockLayoutWorkflow.mockRejectedValue(new Error('ELK layout error'));

      const response = await app.request(
        jsonRequest('http://localhost/analyze', {
          skills: [{ id: 'skill-1', name: 'Test', description: 'test', content: 'content' }],
        })
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('WORKFLOW_LAYOUT_FAILED');
    });

    it('IT-661: analyzes workflow from template by ID', async () => {
      const aiResponse = JSON.stringify({
        nodes: [
          { id: 'start-1', type: 'start', label: 'Start', position: { x: 0, y: 0 }, inputs: [] },
          { id: 'step-1', type: 'action', label: 'Action', position: { x: 0, y: 100 } },
          { id: 'end-1', type: 'end', label: 'End', position: { x: 0, y: 200 }, outputs: [] },
        ],
        edges: [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start-1', targetNodeId: 'step-1' },
          { id: 'e2', type: 'sequential', sourceNodeId: 'step-1', targetNodeId: 'end-1' },
        ],
        aiGenerated: true,
        aiConfidence: 0.9,
      });

      mockAgentQuery.mockResolvedValue({ text: aiResponse } as any);

      const response = await app.request(
        jsonRequest('http://localhost/analyze', { templateId: 'tmpl-1' })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.workflow.sourceTemplateId).toBe('tmpl-1');
      expect(templateService.getById).toHaveBeenCalledWith('tmpl-1');
    });
  });
});
