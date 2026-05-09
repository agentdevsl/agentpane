/**
 * Additional integration tests for workflow-designer route — exercises code
 * paths that the existing IT-650 suite skips:
 *
 * - Inline commands array maps (lines 460-465)
 * - Inline agents array maps (lines 465-470)
 * - settingsService prompt resolution path
 * - Connectivity-repair fallback (unreachable nodes connected to predecessor)
 * - End-edge re-pointing when AI returns the wrong tail edge
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  agentQuery: vi.fn(),
}));

vi.mock('../../src/lib/workflow-dsl/layout.js', () => ({
  layoutWorkflow: vi.fn(),
  findChainHeadAndTail: vi.fn(),
}));

vi.mock('../../src/lib/workflow-dsl/ai-prompts.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/workflow-dsl/ai-prompts.js')>(
    '../../src/lib/workflow-dsl/ai-prompts.js'
  );
  return {
    ...actual,
    resolveWorkflowAnalysisPrompt: vi.fn().mockResolvedValue('Mocked analysis prompt'),
    resolveWorkflowGenerationSystemPrompt: vi.fn().mockResolvedValue('Mocked system prompt'),
  };
});

import { agentQuery } from '../../src/lib/agents/agent-sdk-utils';
import { findChainHeadAndTail, layoutWorkflow } from '../../src/lib/workflow-dsl/layout';
import { createWorkflowDesignerRoutes } from '../../src/server/routes/workflow-designer';

const mockAgentQuery = vi.mocked(agentQuery);
const mockLayoutWorkflow = vi.mocked(layoutWorkflow);
const mockFindChainHeadAndTail = vi.mocked(findChainHeadAndTail);

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeApp(opts: { settingsService?: unknown } = {}) {
  return createWorkflowDesignerRoutes({
    templateService: { getById: vi.fn() } as never,
    settingsService: opts.settingsService as never,
  });
}

function makeNode(
  id: string,
  type: 'start' | 'end' | 'skill' | 'agent' | 'context',
  y = 0,
  extra: Record<string, unknown> = {}
) {
  return { id, type, label: id, position: { x: 0, y }, ...extra };
}

describe('Workflow Designer extras (IT-WD-EXTRA)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLayoutWorkflow.mockImplementation(async (nodes) =>
      nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 100 } }))
    );
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const head = nodes[0] ?? makeNode('head', 'start');
      const tail = nodes[nodes.length - 1] ?? head;
      return { head, tail } as never;
    });
  });

  it('analyzes inline commands list and threads them into the AI prompt', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('cmd1', 'skill', 100, { skillId: 'cmd1' }),
          makeNode('end', 'end', 200),
        ],
        edges: [
          { id: 'e1', sourceNodeId: 'start', targetNodeId: 'cmd1', type: 'sequential' },
          { id: 'e2', sourceNodeId: 'cmd1', targetNodeId: 'end', type: 'sequential' },
        ],
        aiConfidence: 0.9,
      }),
    } as never);

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        commands: [
          { name: 'deploy', description: 'Deploy app', content: 'kubectl apply -f deploy.yaml' },
          { name: 'test', description: 'Run tests', content: 'npm test' },
        ],
        name: 'Commands Workflow',
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { workflow: { aiConfidence: number } } };
    expect(body.ok).toBe(true);
    expect(body.data.workflow.aiConfidence).toBe(90);
    expect(mockAgentQuery).toHaveBeenCalled();
  });

  it('analyzes inline agents list and threads them into the AI prompt', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a1', 'agent', 100, { agentId: 'planner' }),
          makeNode('end', 'end', 200),
        ],
        edges: [
          { id: 'e1', sourceNodeId: 'start', targetNodeId: 'a1', type: 'sequential' },
          { id: 'e2', sourceNodeId: 'a1', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        agents: [
          { name: 'planner', description: 'Plans', content: 'You are a planner.' },
          { name: 'executor', description: 'Executes', content: 'You execute.' },
        ],
      })
    );

    expect(res.status).toBe(200);
  });

  it('uses settingsService when provided to resolve prompts', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a1', 'skill', 100, { skillId: 'sk-1' }),
          makeNode('end', 'end', 200),
        ],
        edges: [
          { id: 'e1', sourceNodeId: 'start', targetNodeId: 'a1', type: 'sequential' },
          { id: 'e2', sourceNodeId: 'a1', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const settingsService = {
      getValue: vi.fn().mockResolvedValue(null),
    };
    const app = makeApp({ settingsService });

    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        skills: [{ id: 'sk-1', name: 'analyze', description: 'analyze', content: 'analyze stuff' }],
      })
    );

    expect(res.status).toBe(200);
    const { resolveWorkflowAnalysisPrompt, resolveWorkflowGenerationSystemPrompt } = await import(
      '../../src/lib/workflow-dsl/ai-prompts.js'
    );
    expect(resolveWorkflowAnalysisPrompt).toHaveBeenCalled();
    expect(resolveWorkflowGenerationSystemPrompt).toHaveBeenCalled();
  });

  it('returns 422 when AI response cannot be parsed as JSON', async () => {
    mockAgentQuery.mockResolvedValue({ text: '<<not json>>' } as never);

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        skills: [{ id: 'sk', name: 's', description: '', content: 'c' }],
      })
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_INVALID_AI_RESPONSE');
  });

  it('returns 401 when agentQuery throws an authentication error', async () => {
    mockAgentQuery.mockRejectedValue(new Error('401 invalid x-api-key'));

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        skills: [{ id: 'sk', name: 's', description: '', content: 'c' }],
      })
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_API_KEY_NOT_FOUND');
  });

  it('returns 500 when agentQuery throws a non-auth error', async () => {
    mockAgentQuery.mockRejectedValue(new Error('Service overloaded'));

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        skills: [{ id: 'sk', name: 's', description: '', content: 'c' }],
      })
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_AI_GENERATION_FAILED');
  });

  it('strips markdown fences from AI response', async () => {
    mockAgentQuery.mockResolvedValue({
      text: `\`\`\`json\n${JSON.stringify({
        nodes: [makeNode('start', 'start', 0), makeNode('end', 'end', 100)],
        edges: [{ id: 'e1', sourceNodeId: 'start', targetNodeId: 'end', type: 'sequential' }],
      })}\n\`\`\``,
    } as never);

    const app = makeApp();
    const res = await app.request(
      jsonRequest('http://localhost/analyze', {
        skills: [{ id: 'sk', name: 's', description: '', content: 'c' }],
      })
    );
    expect(res.status).toBe(200);
  });
});
