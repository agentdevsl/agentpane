/**
 * Coverage gap-filler for src/server/routes/workflow-designer.ts.
 *
 * Targets the validate-and-repair branches the existing analyze test
 * skips (lines 241-380): start-edge replacement, end-edge replacement,
 * unreachable-node connectivity repair, end-edge re-pointing after
 * connectivity repair.
 *
 * Pattern follows the existing route-workflow-designer-extras.test.ts —
 * mocks agentQuery to return AI responses with broken edges, and asserts
 * the repaired workflow shape that `parseAIResponse` returns.
 *
 * IT-IDs: IT-2540 to IT-2569
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  agentQuery: vi.fn(),
}));

vi.mock('../../src/lib/workflow-dsl/layout.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/workflow-dsl/layout.js')>(
    '../../src/lib/workflow-dsl/layout.js'
  );
  return {
    ...actual,
    layoutWorkflow: vi.fn(),
    findChainHeadAndTail: vi.fn(),
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

function makeApp() {
  return createWorkflowDesignerRoutes({
    templateService: { getById: vi.fn() } as never,
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

interface RepairResult {
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string; type: string }>;
  nodes: Array<{ id: string; type: string }>;
}

async function runAndGetWorkflow(
  body: Record<string, unknown>
): Promise<{ status: number; workflow: RepairResult }> {
  const app = makeApp();
  const res = await app.request(jsonRequest('http://localhost/analyze', body));
  if (res.status !== 200) {
    return { status: res.status, workflow: { edges: [], nodes: [] } };
  }
  const json = (await res.json()) as { data: { workflow: RepairResult } };
  return { status: res.status, workflow: json.data.workflow };
}

describe('Workflow Designer validate-and-repair branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLayoutWorkflow.mockImplementation(async (nodes) =>
      nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 100 } }))
    );
    // Default: head/tail picked by node order. Tests override per case.
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const head = nodes[0] ?? makeNode('h', 'skill');
      const tail = nodes[nodes.length - 1] ?? head;
      return { head, tail } as never;
    });
  });

  // ─── Auto-add start/end when AI omits them ────────────────────────

  it('IT-2540: auto-generates a start node when AI omits one', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('a', 'skill', 0, { skillId: 'a', skillName: 'a' }),
          makeNode('end', 'end', 100),
        ],
        edges: [{ id: 'e', sourceNodeId: 'a', targetNodeId: 'end', type: 'sequential' }],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    expect(result.status).toBe(200);
    expect(result.workflow.nodes.some((n) => n.type === 'start')).toBe(true);
  });

  it('IT-2541: auto-generates an end node when AI omits one', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
        ],
        edges: [{ id: 'e', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' }],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    expect(result.status).toBe(200);
    expect(result.workflow.nodes.some((n) => n.type === 'end')).toBe(true);
  });

  // ─── Start edge replacement ───────────────────────────────────────

  it('IT-2542: replaces incorrect start->wrong-node edge with start->head edge', async () => {
    // AI generates an incorrect start->c edge; head is "a"; expect repair.
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const a = nodes.find((n) => n.id === 'a')!;
      const c = nodes.find((n) => n.id === 'c')!;
      return { head: a, tail: c } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('c', 'skill', 300, { skillId: 'c', skillName: 'c' }),
          makeNode('end', 'end', 400),
        ],
        edges: [
          // BUG: AI connected start to the wrong node
          { id: 'wrong', sourceNodeId: 'start', targetNodeId: 'c', type: 'sequential' },
          { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', type: 'sequential' },
          { id: 'bc', sourceNodeId: 'b', targetNodeId: 'c', type: 'sequential' },
          { id: 'ce', sourceNodeId: 'c', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    expect(result.status).toBe(200);
    // The wrong start edge (to 'c') is replaced with a start->a edge
    const startEdges = result.workflow.edges.filter((e) => e.sourceNodeId === 'start');
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0]!.targetNodeId).toBe('a');
  });

  it('IT-2543: adds a start->head edge when AI omits start edges entirely', async () => {
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const a = nodes.find((n) => n.id === 'a')!;
      const b = nodes.find((n) => n.id === 'b')!;
      return { head: a, tail: b } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('end', 'end', 300),
        ],
        edges: [
          // No edge from start at all
          { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', type: 'sequential' },
          { id: 'be', sourceNodeId: 'b', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    const startEdges = result.workflow.edges.filter((e) => e.sourceNodeId === 'start');
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0]!.targetNodeId).toBe('a');
  });

  // ─── End edge replacement ─────────────────────────────────────────

  it('IT-2544: replaces incorrect end edges with tail->end edge', async () => {
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const a = nodes.find((n) => n.id === 'a')!;
      const c = nodes.find((n) => n.id === 'c')!;
      return { head: a, tail: c } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('c', 'skill', 300, { skillId: 'c', skillName: 'c' }),
          makeNode('end', 'end', 400),
        ],
        edges: [
          { id: 'sa', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' },
          { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', type: 'sequential' },
          { id: 'bc', sourceNodeId: 'b', targetNodeId: 'c', type: 'sequential' },
          // BUG: end edge from wrong node ('a' instead of 'c')
          { id: 'wrong-end', sourceNodeId: 'a', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    const endEdges = result.workflow.edges.filter((e) => e.targetNodeId === 'end');
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0]!.sourceNodeId).toBe('c');
  });

  it('IT-2545: adds a tail->end edge when AI omits end edges entirely', async () => {
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const a = nodes.find((n) => n.id === 'a')!;
      const b = nodes.find((n) => n.id === 'b')!;
      return { head: a, tail: b } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('end', 'end', 300),
        ],
        edges: [
          { id: 'sa', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' },
          { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    const endEdges = result.workflow.edges.filter((e) => e.targetNodeId === 'end');
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0]!.sourceNodeId).toBe('b');
  });

  // ─── Unreachable node repair ─────────────────────────────────────

  it('IT-2546: connects unreachable nodes from their array predecessor', async () => {
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      const a = nodes.find((n) => n.id === 'a')!;
      const c = nodes.find((n) => n.id === 'c')!;
      return { head: a, tail: c } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('c', 'skill', 300, { skillId: 'c', skillName: 'c' }),
          makeNode('end', 'end', 400),
        ],
        edges: [
          { id: 'sa', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' },
          // 'b' is unreachable: no edge into it. 'c' is reachable from 'a' via... no edge either!
          { id: 'ce', sourceNodeId: 'c', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    // Repair connects b from a (its array predecessor) and c from b (its array predecessor)
    const intoB = result.workflow.edges.filter((e) => e.targetNodeId === 'b');
    const intoC = result.workflow.edges.filter((e) => e.targetNodeId === 'c');
    expect(intoB.length).toBeGreaterThan(0);
    expect(intoC.length).toBeGreaterThan(0);
  });

  // ─── Edges to non-existent nodes are stripped ─────────────────────

  it('IT-2547: strips edges referencing nodes that were not generated', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('end', 'end', 200),
        ],
        edges: [
          { id: 'sa', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' },
          { id: 'ae', sourceNodeId: 'a', targetNodeId: 'end', type: 'sequential' },
          // BUG: edge references a node that does not exist
          { id: 'ghost', sourceNodeId: 'a', targetNodeId: 'ghost-id', type: 'sequential' },
          { id: 'ghost2', sourceNodeId: 'ghost-id', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    // Ghost edges removed
    expect(result.workflow.edges.find((e) => e.id === 'ghost')).toBeUndefined();
    expect(result.workflow.edges.find((e) => e.id === 'ghost2')).toBeUndefined();
    // Real edges preserved
    expect(result.workflow.edges.find((e) => e.id === 'sa')).toBeDefined();
    expect(result.workflow.edges.find((e) => e.id === 'ae')).toBeDefined();
  });

  // ─── Empty nodes throws ───────────────────────────────────────────

  it('IT-2548: returns 422 when AI returns no valid nodes', async () => {
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          // All nodes will fail schema validation (missing required fields)
          { id: 'bad', invalidField: true },
        ],
        edges: [],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    expect(result.status).toBe(422);
  });

  // ─── Re-pointing end after connectivity repair ────────────────────

  it('IT-2549: re-points end edge from true tail after unreachable-node repair', async () => {
    let callCount = 0;
    mockFindChainHeadAndTail.mockImplementation((nodes) => {
      callCount++;
      const a = nodes.find((n) => n.id === 'a')!;
      const c = nodes.find((n) => n.id === 'c')!;
      // First call (initial chain detection): tail is 'c'.
      // Second call (after connectivity repair): tail is still 'c' but the
      // existing end edge points from 'a', so re-pointing kicks in.
      void callCount;
      return { head: a, tail: c } as never;
    });
    mockAgentQuery.mockResolvedValue({
      text: JSON.stringify({
        nodes: [
          makeNode('start', 'start', 0),
          makeNode('a', 'skill', 100, { skillId: 'a', skillName: 'a' }),
          makeNode('b', 'skill', 200, { skillId: 'b', skillName: 'b' }),
          makeNode('c', 'skill', 300, { skillId: 'c', skillName: 'c' }),
          makeNode('end', 'end', 400),
        ],
        edges: [
          { id: 'sa', sourceNodeId: 'start', targetNodeId: 'a', type: 'sequential' },
          { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', type: 'sequential' },
          // 'c' is unreachable; end edge points from 'a' (wrong tail)
          { id: 'wrong-end', sourceNodeId: 'a', targetNodeId: 'end', type: 'sequential' },
        ],
      }),
    } as never);

    const result = await runAndGetWorkflow({ commands: [{ name: 'a', content: 'x' }] });
    expect(result.status).toBe(200);
    // After repair, end edge should point from the true tail
    const endEdges = result.workflow.edges.filter((e) => e.targetNodeId === 'end');
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0]!.sourceNodeId).toBe('c');
  });
});
