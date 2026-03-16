/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEdge, WorkflowNode } from '@/lib/workflow-dsl/types';

// Create a mock ELK class with controllable layout behavior
const mockLayoutFn = vi.fn();

class MockELK {
  layout = mockLayoutFn;
}

// Mock the ELK module
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: MockELK,
}));

// Helper to create workflow nodes
function makeNode(
  id: string,
  type: WorkflowNode['type'],
  overrides: Partial<WorkflowNode> = {}
): WorkflowNode {
  const base = {
    id,
    type,
    label: overrides.label ?? id,
    position: overrides.position ?? { x: 0, y: 0 },
    ...overrides,
  };

  switch (type) {
    case 'start':
      return { ...base, type: 'start' } as WorkflowNode;
    case 'end':
      return { ...base, type: 'end' } as WorkflowNode;
    case 'skill':
      return { ...base, type: 'skill', skillId: 'sk-1', skillName: 'Test Skill' } as WorkflowNode;
    case 'context':
      return { ...base, type: 'context', content: 'test content' } as WorkflowNode;
    case 'agent':
      return { ...base, type: 'agent', agentId: 'ag-1', agentName: 'Test Agent' } as WorkflowNode;
    default:
      return base as WorkflowNode;
  }
}

function makeEdge(
  sourceNodeId: string,
  targetNodeId: string,
  type: WorkflowEdge['type'] = 'sequential'
): WorkflowEdge {
  return {
    id: `edge-${sourceNodeId}-${targetNodeId}`,
    type,
    sourceNodeId,
    targetNodeId,
  } as WorkflowEdge;
}

describe('Layout Module - Extended Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLayoutFn.mockResolvedValue({ children: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =============================================================================
  // calculateUniformNodeWidth Tests
  // =============================================================================

  describe('calculateUniformNodeWidth', () => {
    it('returns MIN_NODE_WIDTH (150) for empty nodes array', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const result = calculateUniformNodeWidth([]);

      expect(result).toBe(150);
    });

    it('returns MIN_NODE_WIDTH for nodes with very short labels', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('n1', 'start', { label: 'A' })];
      const result = calculateUniformNodeWidth(nodes);

      expect(result).toBe(150);
    });

    it('returns larger width for nodes with long labels', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodes = [
        makeNode('n1', 'skill', { label: 'This is a really long skill name for testing' }),
      ];
      const result = calculateUniformNodeWidth(nodes);

      expect(result).toBeGreaterThan(150);
    });

    it('returns width based on the widest node', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodes = [
        makeNode('n1', 'start', { label: 'A' }),
        makeNode('n2', 'skill', { label: 'Medium length label text' }),
        makeNode('n3', 'end', { label: 'B' }),
      ];
      const result = calculateUniformNodeWidth(nodes);

      // Should be at least 150 and rounded to nearest 10
      expect(result % 10).toBe(0);
      expect(result).toBeGreaterThanOrEqual(150);
    });

    it('caps at MAX_NODE_WIDTH (450) for very long labels', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodes = [
        makeNode('n1', 'skill', {
          label: 'A'.repeat(200), // extremely long label
        }),
      ];
      const result = calculateUniformNodeWidth(nodes);

      expect(result).toBeLessThanOrEqual(450);
    });

    it('rounds up to nearest 10px', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('n1', 'start', { label: 'Medium' })];
      const result = calculateUniformNodeWidth(nodes);

      expect(result % 10).toBe(0);
    });

    it('accounts for secondary text in skill nodes', async () => {
      const { calculateUniformNodeWidth } = await import('@/lib/workflow-dsl/layout');

      const nodeWithoutSecondary = [makeNode('n1', 'start', { label: 'Test' })];
      const nodeWithSecondary = [
        {
          id: 'n2',
          type: 'skill' as const,
          label: 'Test',
          position: { x: 0, y: 0 },
          skillId: 'very-long-skill-identifier-name',
          skillName: 'My Skill',
        } as WorkflowNode,
      ];

      const widthWithout = calculateUniformNodeWidth(nodeWithoutSecondary);
      const widthWith = calculateUniformNodeWidth(nodeWithSecondary);

      // The node with secondary text should be at least as wide
      expect(widthWith).toBeGreaterThanOrEqual(widthWithout);
    });
  });

  // =============================================================================
  // findChainHeadAndTail Tests
  // =============================================================================

  describe('findChainHeadAndTail', () => {
    it('returns same node for single-node array', async () => {
      const { findChainHeadAndTail } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('n1', 'skill')];
      const result = findChainHeadAndTail(nodes, []);

      expect(result.head.id).toBe('n1');
      expect(result.tail.id).toBe('n1');
    });

    it('finds correct head and tail in a linear chain', async () => {
      const { findChainHeadAndTail } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('a', 'skill'), makeNode('b', 'skill'), makeNode('c', 'skill')];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];

      const result = findChainHeadAndTail(nodes, edges);

      expect(result.head.id).toBe('a');
      expect(result.tail.id).toBe('c');
    });

    it('handles reversed node order in the array', async () => {
      const { findChainHeadAndTail } = await import('@/lib/workflow-dsl/layout');

      // Nodes in reverse order but edges define a->b->c
      const nodes = [makeNode('c', 'skill'), makeNode('b', 'skill'), makeNode('a', 'skill')];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];

      const result = findChainHeadAndTail(nodes, edges);

      expect(result.head.id).toBe('a');
      expect(result.tail.id).toBe('c');
    });

    it('handles nodes with no edges (isolated nodes)', async () => {
      const { findChainHeadAndTail } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('a', 'skill'), makeNode('b', 'skill')];

      const result = findChainHeadAndTail(nodes, []);

      // Both are head candidates with equal reachability (1 each)
      // First candidate with best reachable wins
      expect(result.head).toBeDefined();
      expect(result.tail).toBeDefined();
    });

    it('handles forked chains by picking the longest', async () => {
      const { findChainHeadAndTail } = await import('@/lib/workflow-dsl/layout');

      const nodes = [
        makeNode('a', 'skill'),
        makeNode('b', 'skill'),
        makeNode('c', 'skill'),
        makeNode('d', 'skill'), // isolated fork head
      ];
      const edges = [
        makeEdge('a', 'b'),
        makeEdge('b', 'c'),
        // d is isolated - shorter chain
      ];

      const result = findChainHeadAndTail(nodes, edges);

      // Main chain a->b->c should win
      expect(result.head.id).toBe('a');
      expect(result.tail.id).toBe('c');
    });
  });

  // =============================================================================
  // ensureStartEndConnected Tests
  // =============================================================================

  describe('ensureStartEndConnected', () => {
    it('returns original edges when no middle nodes exist', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('e', 'end')];
      const edges: WorkflowEdge[] = [];

      const result = ensureStartEndConnected(nodes, edges);

      expect(result).toEqual(edges);
    });

    it('creates start edge when missing', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('m1', 'skill'), makeNode('e', 'end')];
      const edges = [makeEdge('m1', 'e')];

      const result = ensureStartEndConnected(nodes, edges);

      // Should have added a start -> m1 edge
      const startEdge = result.find((e) => e.sourceNodeId === 's');
      expect(startEdge).toBeDefined();
      expect(startEdge?.targetNodeId).toBe('m1');
    });

    it('creates end edge when missing', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('m1', 'skill'), makeNode('e', 'end')];
      const edges = [makeEdge('s', 'm1')];

      const result = ensureStartEndConnected(nodes, edges);

      // Should have added m1 -> end edge
      const endEdge = result.find((e) => e.targetNodeId === 'e');
      expect(endEdge).toBeDefined();
      expect(endEdge?.sourceNodeId).toBe('m1');
    });

    it('preserves correct edges and only replaces wrong ones', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [
        makeNode('s', 'start'),
        makeNode('m1', 'skill'),
        makeNode('m2', 'skill'),
        makeNode('e', 'end'),
      ];
      const edges = [makeEdge('s', 'm1'), makeEdge('m1', 'm2'), makeEdge('m2', 'e')];

      const result = ensureStartEndConnected(nodes, edges);

      // All edges correct, should keep them
      expect(result.some((e) => e.sourceNodeId === 's' && e.targetNodeId === 'm1')).toBe(true);
      expect(result.some((e) => e.sourceNodeId === 'm2' && e.targetNodeId === 'e')).toBe(true);
    });

    it('does not mutate input edges array', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('m1', 'skill'), makeNode('e', 'end')];
      const edges = [makeEdge('m1', 'e')];
      const edgesCopy = [...edges];

      ensureStartEndConnected(nodes, edges);

      expect(edges).toEqual(edgesCopy);
    });

    it('handles workflow with no start node', async () => {
      const { ensureStartEndConnected } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('m1', 'skill'), makeNode('e', 'end')];
      const edges = [makeEdge('m1', 'e')];

      const result = ensureStartEndConnected(nodes, edges);

      // Should still fix the end edge and not crash
      expect(result).toBeDefined();
    });
  });

  // =============================================================================
  // toReactFlowNodes Tests
  // =============================================================================

  describe('toReactFlowNodes', () => {
    it('converts workflow nodes to ReactFlow format with compact types', async () => {
      const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('sk', 'skill'), makeNode('e', 'end')];

      const result = toReactFlowNodes(nodes);

      expect(result).toHaveLength(3);
      expect(result[0]?.type).toBe('compactStart');
      expect(result[1]?.type).toBe('compactSkill');
      expect(result[2]?.type).toBe('compactEnd');
    });

    it('passes through standard types when useCompactNodes is false', async () => {
      const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start')];
      const result = toReactFlowNodes(nodes, { useCompactNodes: false });

      expect(result[0]?.type).toBe('start');
    });

    it('includes nodeIndex and uniformWidth in data', async () => {
      const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('e', 'end')];
      const result = toReactFlowNodes(nodes, { uniformWidth: 300 });

      expect(result[0]?.data.nodeIndex).toBe(0);
      expect(result[0]?.data.uniformWidth).toBe(300);
      expect(result[1]?.data.nodeIndex).toBe(1);
    });

    it('extracts skill-specific data', async () => {
      const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const nodes: WorkflowNode[] = [
        {
          id: 'sk1',
          type: 'skill',
          label: 'My Skill',
          position: { x: 0, y: 0 },
          skillId: 'sk-id',
          skillName: 'Skill Name',
          inputs: { a: 1 },
          outputs: ['result'],
        },
      ];

      const result = toReactFlowNodes(nodes);

      expect(result[0]?.data.skillId).toBe('sk-id');
      expect(result[0]?.data.skillName).toBe('Skill Name');
      expect(result[0]?.data.inputs).toEqual({ a: 1 });
      expect(result[0]?.data.outputs).toEqual(['result']);
    });
  });

  // =============================================================================
  // toReactFlowEdges Tests
  // =============================================================================

  describe('toReactFlowEdges', () => {
    it('converts sequential edges', async () => {
      const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

      const edges: WorkflowEdge[] = [makeEdge('a', 'b', 'sequential')];
      const result = toReactFlowEdges(edges);

      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('a');
      expect(result[0]?.target).toBe('b');
      expect(result[0]?.type).toBe('sequential');
    });

    it('converts handoff edges with context data', async () => {
      const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

      const edges: WorkflowEdge[] = [
        {
          id: 'e1',
          type: 'handoff',
          sourceNodeId: 'a',
          targetNodeId: 'b',
          context: { key: 'val' },
          preserveHistory: true,
        },
      ];

      const result = toReactFlowEdges(edges);

      expect(result[0]?.type).toBe('handoff');
      expect(result[0]?.data?.context).toEqual({ key: 'val' });
      expect(result[0]?.data?.preserveHistory).toBe(true);
    });

    it('converts dataflow edges with source/target mapping', async () => {
      const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

      const edges: WorkflowEdge[] = [
        {
          id: 'e1',
          type: 'dataflow',
          sourceNodeId: 'a',
          targetNodeId: 'b',
          sourceOutput: 'output1',
          targetInput: 'input1',
          transform: 'uppercase',
        },
      ];

      const result = toReactFlowEdges(edges);

      expect(result[0]?.type).toBe('dataflow');
      expect(result[0]?.data?.sourceOutput).toBe('output1');
      expect(result[0]?.data?.targetInput).toBe('input1');
    });

    it('converts conditional edges with condition and priority', async () => {
      const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

      const edges: WorkflowEdge[] = [
        {
          id: 'e1',
          type: 'conditional',
          sourceNodeId: 'a',
          targetNodeId: 'b',
          condition: 'x > 0',
          priority: 1,
        },
      ];

      const result = toReactFlowEdges(edges);

      expect(result[0]?.type).toBe('conditional');
      expect(result[0]?.data?.condition).toBe('x > 0');
      expect(result[0]?.data?.priority).toBe(1);
    });
  });

  // =============================================================================
  // fromReactFlowNodes Tests
  // =============================================================================

  describe('fromReactFlowNodes', () => {
    it('updates positions from ReactFlow nodes', async () => {
      const { fromReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const originals: WorkflowNode[] = [
        makeNode('n1', 'start', { label: 'Start', position: { x: 0, y: 0 } }),
      ];

      const rfNodes = [{ id: 'n1', type: 'compactStart', position: { x: 100, y: 200 }, data: {} }];

      const result = fromReactFlowNodes(rfNodes as any, originals);

      expect(result[0]?.position).toEqual({ x: 100, y: 200 });
      expect(result[0]?.label).toBe('Start');
    });

    it('throws when original node is not found', async () => {
      const { fromReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

      const originals: WorkflowNode[] = [];
      const rfNodes = [{ id: 'missing', type: 'start', position: { x: 0, y: 0 }, data: {} }];

      expect(() => fromReactFlowNodes(rfNodes as any, originals)).toThrow(
        'Original node not found for id: missing'
      );
    });
  });

  // =============================================================================
  // layoutWorkflow Tests (edge cases)
  // =============================================================================

  describe('layoutWorkflow edge cases', () => {
    it('falls back to vertical stacking when ELK layout fails', async () => {
      mockLayoutFn.mockRejectedValue(new Error('ELK failure'));

      const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('a', 'start'), makeNode('b', 'skill')];

      const result = await layoutWorkflow(nodes, []);

      // Should still return nodes with positions (fallback)
      expect(result).toHaveLength(2);
      expect(result[0]?.position).toBeDefined();
      expect(result[1]?.position).toBeDefined();
      // Second node should be below first
      expect(result[1]!.position.y).toBeGreaterThan(result[0]!.position.y);
    });

    it('filters edges that reference non-existent nodes', async () => {
      mockLayoutFn.mockResolvedValue({
        children: [{ id: 'a', x: 0, y: 0 }],
      });

      const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('a', 'start')];
      const edges = [makeEdge('a', 'nonexistent')];

      // Should not throw
      const result = await layoutWorkflow(nodes, edges);
      expect(result).toHaveLength(1);
    });

    it('preserves original position when node not found in ELK output', async () => {
      mockLayoutFn.mockResolvedValue({ children: [] });

      const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

      const originalPosition = { x: 42, y: 84 };
      const nodes = [makeNode('a', 'start', { position: originalPosition })];

      const result = await layoutWorkflow(nodes, []);

      expect(result[0]?.position).toEqual(originalPosition);
    });

    it('normalizes x positions so minimum x is 0', async () => {
      mockLayoutFn.mockResolvedValue({
        children: [
          { id: 'a', x: 100, y: 0 },
          { id: 'b', x: 200, y: 100 },
        ],
      });

      const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('a', 'start'), makeNode('b', 'end')];

      const result = await layoutWorkflow(nodes, []);

      expect(result[0]?.position.x).toBe(0);
      expect(result[1]?.position.x).toBe(100);
    });
  });

  // =============================================================================
  // layoutWorkflowForReactFlow Tests
  // =============================================================================

  describe('layoutWorkflowForReactFlow', () => {
    it('returns both nodes and edges in ReactFlow format', async () => {
      mockLayoutFn.mockResolvedValue({
        children: [
          { id: 's', x: 0, y: 0 },
          { id: 'e', x: 0, y: 100 },
        ],
      });

      const { layoutWorkflowForReactFlow } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('e', 'end')];
      const edges: WorkflowEdge[] = [];

      const result = await layoutWorkflowForReactFlow(nodes, edges);

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(0);
    });

    it('skips connectivity fix when skipConnectivityFix is true', async () => {
      mockLayoutFn.mockResolvedValue({
        children: [
          { id: 's', x: 0, y: 0 },
          { id: 'm', x: 0, y: 50 },
          { id: 'e', x: 0, y: 100 },
        ],
      });

      const { layoutWorkflowForReactFlow } = await import('@/lib/workflow-dsl/layout');

      const nodes = [makeNode('s', 'start'), makeNode('m', 'skill'), makeNode('e', 'end')];
      // No edges connecting start/end
      const edges: WorkflowEdge[] = [];

      const result = await layoutWorkflowForReactFlow(nodes, edges, {
        skipConnectivityFix: true,
      });

      // With skip, no auto-generated edges should be added
      expect(result.edges).toHaveLength(0);
    });
  });
});
