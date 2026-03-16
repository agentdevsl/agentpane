/**
 * Tests for workflow designer routes.
 *
 * Covers:
 * - POST /analyze: workflow generation from skills/commands/agents or templateId
 * - Validation, error handling, AI response parsing
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowDesignerRoutes } from '../../src/server/routes/workflow-designer';

// ── Mock External Dependencies ──

const mockAgentQuery = vi.fn();

vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  agentQuery: (...args: unknown[]) => mockAgentQuery(...args),
}));

vi.mock('../../src/lib/workflow-dsl/layout.js', () => ({
  layoutWorkflow: vi.fn((nodes: unknown[]) => Promise.resolve(nodes)),
  findChainHeadAndTail: vi.fn((nodes: Array<{ id: string }>) => ({
    head: nodes[0],
    tail: nodes[nodes.length - 1],
  })),
}));

vi.mock('../../src/lib/workflow-dsl/ai-prompts.js', () => ({
  createWorkflowAnalysisPrompt: vi.fn(() => 'mock-prompt'),
  resolveWorkflowAnalysisPrompt: vi.fn(() => Promise.resolve('mock-resolved-prompt')),
  resolveWorkflowGenerationSystemPrompt: vi.fn(() => Promise.resolve('mock-system-prompt')),
  WORKFLOW_GENERATION_SYSTEM_PROMPT: 'mock-system-prompt',
}));

vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_WORKFLOW_MODEL: 'claude-sonnet-4-6',
  getFullModelId: vi.fn((m: string) => m),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid-12345678'),
}));

// ── Helpers ──

function buildMockTemplateService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    sync: vi.fn(),
    syncAll: vi.fn(),
    getMergedConfig: vi.fn(),
    findByRepo: vi.fn(),
  };
}

function buildMockSettingsService() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    getAll: vi.fn(),
  };
}

function makeValidAIResponse() {
  return JSON.stringify({
    nodes: [
      { id: 'start-1', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
      {
        id: 'skill-1',
        type: 'skill',
        label: 'Run Skill',
        position: { x: 0, y: 100 },
        skillId: 'skill-a',
        skillName: 'Test Skill',
        inputs: {},
        outputs: [],
      },
      { id: 'end-1', type: 'end', label: 'End', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', type: 'sequential', sourceNodeId: 'start-1', targetNodeId: 'skill-1' },
      { id: 'e2', type: 'sequential', sourceNodeId: 'skill-1', targetNodeId: 'end-1' },
    ],
    aiGenerated: true,
    aiConfidence: 0.85,
  });
}

let templateService: ReturnType<typeof buildMockTemplateService>;
let settingsService: ReturnType<typeof buildMockSettingsService>;
let app: ReturnType<typeof createWorkflowDesignerRoutes>;

// ── Tests ──

describe('POST /api/workflow-designer/analyze - Generate workflow', () => {
  beforeEach(() => {
    templateService = buildMockTemplateService();
    settingsService = buildMockSettingsService();
    app = createWorkflowDesignerRoutes({
      templateService: templateService as never,
      settingsService: settingsService as never,
    });
    mockAgentQuery.mockResolvedValue({ text: makeValidAIResponse() });
  });

  it('generates a workflow from inline skills', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [
          { id: 'skill-a', name: 'Test Skill', description: 'A test', content: 'echo hello' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.workflow).toBeDefined();
    expect(body.data.workflow.nodes).toHaveLength(3);
    expect(body.data.workflow.edges).toHaveLength(2);
    expect(body.data.workflow.aiGenerated).toBe(true);
    expect(body.data.workflow.status).toBe('draft');
  });

  it('generates a workflow from a templateId', async () => {
    templateService.getById.mockResolvedValue({
      ok: true,
      value: {
        id: 'tpl-1',
        name: 'My Template',
        description: 'Template desc',
        cachedSkills: [{ id: 'sk-1', name: 'Skill 1', content: 'echo 1', description: null }],
        cachedCommands: [],
        cachedAgents: [],
      },
    });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tpl-1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.workflow.sourceTemplateId).toBe('tpl-1');
    expect(body.data.workflow.name).toBe('My Template');
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('returns 400 when no templateId or content provided', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when template not found', async () => {
    templateService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Template not found', status: 404 },
    });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'nonexistent-id' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('returns 400 when template has no content', async () => {
    templateService.getById.mockResolvedValue({
      ok: true,
      value: {
        id: 'tpl-empty',
        name: 'Empty Template',
        cachedSkills: [],
        cachedCommands: [],
        cachedAgents: [],
      },
    });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tpl-empty' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_NO_CONTENT');
  });

  it('returns 500 when AI returns empty response', async () => {
    mockAgentQuery.mockResolvedValue({ text: '' });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_AI_GENERATION_FAILED');
  });

  it('returns 401 when API key is not configured', async () => {
    mockAgentQuery.mockRejectedValue(new Error('401 authentication_error: invalid x-api-key'));

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_API_KEY_NOT_FOUND');
  });

  it('returns 500 when Agent SDK throws non-auth error', async () => {
    mockAgentQuery.mockRejectedValue(new Error('SDK crashed'));

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_AI_GENERATION_FAILED');
  });

  it('returns 422 when AI response is not valid JSON', async () => {
    mockAgentQuery.mockResolvedValue({ text: 'This is not JSON at all' });

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_INVALID_AI_RESPONSE');
  });

  it('returns 500 when layout fails', async () => {
    const { layoutWorkflow } = await import('../../src/lib/workflow-dsl/layout.js');
    (layoutWorkflow as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ELK layout failed')
    );

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WORKFLOW_LAYOUT_FAILED');
  });

  it('accepts commands and agents as inline content', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [{ name: 'build', content: 'npm run build' }],
        agents: [{ name: 'reviewer', content: 'Review PRs' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.workflow).toBeDefined();
  });

  it('converts aiConfidence from 0-1 float to 0-100 integer', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: [{ id: 'skill-a', name: 'Test Skill', content: 'echo hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.workflow.aiConfidence).toBe(85);
  });
});
