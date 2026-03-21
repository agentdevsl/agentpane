import type { Node as ReactFlowNode } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConditionalEdge,
  DataflowEdge,
  HandoffEdge,
  SequentialEdge,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '@/lib/workflow-dsl/types';

// Create a mock ELK class with controllable layout behavior
const mockLayoutFn = vi.fn();

class MockELK {
  layout = mockLayoutFn;
}

// Mock the ELK module with our class
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: MockELK,
}));

describe('Workflow DSL Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock behavior - return positioned nodes
    mockLayoutFn.mockResolvedValue({
      children: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =============================================================================
  // LAYOUT MODULE TESTS
  // =============================================================================

  describe('Layout Module', () => {
    describe('layoutWorkflow', () => {
      it('returns empty array when no nodes provided', async () => {
        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const result = await layoutWorkflow([], []);

        expect(result).toEqual([]);
      });

      it('applies ELK layout to nodes and returns positioned nodes', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [
            { id: 'start', x: 0, y: 0 },
            { id: 'task1', x: 0, y: 100 },
            { id: 'end', x: 0, y: 200 },
          ],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'task1',
            type: 'skill',
            label: 'Task 1',
            position: { x: 0, y: 0 },
            skillId: 'npm-test',
            skillName: 'Npm Test',
            description: 'npm test',
          },
          { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } },
        ];

        const edges: WorkflowEdge[] = [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'task1' },
          { id: 'e2', type: 'sequential', sourceNodeId: 'task1', targetNodeId: 'end' },
        ];

        const result = await layoutWorkflow(nodes, edges);

        expect(result).toHaveLength(3);
        expect(result[0].position).toEqual({ x: 0, y: 0 });
        expect(result[1].position).toEqual({ x: 0, y: 100 });
        expect(result[2].position).toEqual({ x: 0, y: 200 });
      });

      it('preserves original node properties after layout', async () => {
        // Position x=50 normalizes to x=0 since it's the only node (min x = 50, shifted by -50)
        mockLayoutFn.mockResolvedValue({
          children: [{ id: 'skill1', x: 50, y: 100 }],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'skill1',
            type: 'skill',
            label: 'Review PR',
            position: { x: 0, y: 0 },
            skillId: 'review-pr',
            skillName: 'PR Review',
            description: 'Review pull request',
            metadata: { priority: 'high' },
          },
        ];

        const result = await layoutWorkflow(nodes, []);

        expect(result[0].skillId).toBe('review-pr');
        expect(result[0].skillName).toBe('PR Review');
        expect(result[0].description).toBe('Review pull request');
        expect(result[0].metadata).toEqual({ priority: 'high' });
        // Position is normalized: x shifted so min is 0
        expect(result[0].position).toEqual({ x: 0, y: 100 });
      });

      it('uses custom layout options when provided', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [{ id: 'node1', x: 0, y: 0 }],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'node1', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
        ];

        await layoutWorkflow(nodes, [], {
          direction: 'RIGHT',
          algorithm: 'layered',
          nodeSpacing: 50,
          layerSpacing: 100,
        });

        expect(mockLayoutFn).toHaveBeenCalledWith(
          expect.objectContaining({
            layoutOptions: expect.objectContaining({
              'elk.direction': 'RIGHT',
              'elk.algorithm': 'layered',
              'elk.spacing.nodeNode': '50',
              'elk.layered.spacing.nodeNodeBetweenLayers': '100',
            }),
          })
        );
      });

      it('falls back to simple positioning when ELK fails', async () => {
        mockLayoutFn.mockRejectedValue(new Error('ELK layout failed'));

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'task1',
            type: 'skill',
            label: 'Task 1',
            position: { x: 0, y: 0 },
            skillId: 'npm-test',
            skillName: 'Npm Test',
            description: 'npm test',
          },
          { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } },
        ];

        const result = await layoutWorkflow(nodes, []);

        expect(result).toHaveLength(3);
        // Fallback uses sequential vertical positioning
        expect(result[0].position.x).toBe(0);
        expect(result[1].position.x).toBe(0);
        expect(result[2].position.x).toBe(0);
      });

      it('filters out edges with non-existent node references', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [
            { id: 'start', x: 0, y: 0 },
            { id: 'end', x: 0, y: 100 },
          ],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } },
        ];

        const edges: WorkflowEdge[] = [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
          { id: 'e2', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'nonexistent' },
          { id: 'e3', type: 'sequential', sourceNodeId: 'nonexistent', targetNodeId: 'end' },
        ];

        await layoutWorkflow(nodes, edges);

        expect(mockLayoutFn).toHaveBeenCalledWith(
          expect.objectContaining({
            edges: [expect.objectContaining({ id: 'e1' })],
          })
        );
      });

      it('uses original position when node is missing from layout output', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [
            { id: 'start', x: 10, y: 20 },
            // task1 missing from output
          ],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'task1',
            type: 'skill',
            label: 'Task 1',
            position: { x: 100, y: 200 },
            skillId: 'test',
            skillName: 'Test',
            description: 'test',
          },
        ];

        const result = await layoutWorkflow(nodes, []);

        // Node missing from ELK output falls back to original position
        expect(result[1].position).toEqual({ x: 100, y: 200 });
      });

      it('normalizes positions to start at x=0', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [
            { id: 'n1', x: 100, y: 0 },
            { id: 'n2', x: 200, y: 100 },
            { id: 'n3', x: 150, y: 200 },
          ],
        });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'n1', type: 'start', label: 'N1', position: { x: 0, y: 0 } },
          { id: 'n2', type: 'end', label: 'N2', position: { x: 0, y: 0 } },
          { id: 'n3', type: 'end', label: 'N3', position: { x: 0, y: 0 } },
        ];

        const result = await layoutWorkflow(nodes, []);

        // Positions should be shifted so minimum x is 0
        expect(result[0].position.x).toBe(0); // 100 - 100
        expect(result[1].position.x).toBe(100); // 200 - 100
        expect(result[2].position.x).toBe(50); // 150 - 100
      });
    });

    describe('toReactFlowNodes', () => {
      it('converts workflow nodes to ReactFlow nodes with compact types', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'skill1',
            type: 'skill',
            label: 'Review',
            position: { x: 0, y: 100 },
            skillId: 'review-pr',
            skillName: 'PR Review',
          },
          {
            id: 'cmd1',
            type: 'skill',
            label: 'Build',
            position: { x: 0, y: 200 },
            skillId: 'npm-run-build',
            skillName: 'Npm Run Build',
          },
          {
            id: 'agent1',
            type: 'agent',
            label: 'AI Agent',
            position: { x: 0, y: 300 },
            agentId: 'code-agent',
            agentName: 'Code Agent',
          },
          { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 400 } },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result).toHaveLength(5);
        expect(result[0].type).toBe('compactStart');
        expect(result[1].type).toBe('compactSkill');
        expect(result[2].type).toBe('compactSkill');
        expect(result[3].type).toBe('compactAgent');
        expect(result[4].type).toBe('compactEnd');
      });

      it('converts workflow nodes to ReactFlow nodes without compact types', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'skill1',
            type: 'skill',
            label: 'Review',
            position: { x: 0, y: 100 },
            skillId: 'review-pr',
            skillName: 'PR Review',
          },
        ];

        const result = toReactFlowNodes(nodes, { useCompactNodes: false });

        expect(result[0].type).toBe('start');
        expect(result[1].type).toBe('skill');
      });

      it('includes node-specific data in ReactFlow node data field', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'skill1',
            type: 'skill',
            label: 'Review',
            position: { x: 0, y: 100 },
            skillId: 'review-pr',
            skillName: 'PR Review',
            inputs: { target: 'main' },
            outputs: ['reviewResult'],
            description: 'Review the PR',
          },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result[0].data.label).toBe('Review');
        expect(result[0].data.description).toBe('Review the PR');
        expect(result[0].data.skillId).toBe('review-pr');
        expect(result[0].data.skillName).toBe('PR Review');
        expect(result[0].data.inputs).toEqual({ target: 'main' });
        expect(result[0].data.outputs).toEqual(['reviewResult']);
        expect(result[0].data.nodeIndex).toBe(0);
        expect(result[0].data.nodeType).toBe('skill');
      });

      it('extracts skill node data correctly for command-mapped skills', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'cmd1',
            type: 'skill',
            label: 'Build',
            position: { x: 0, y: 0 },
            skillId: 'npm-run-build',
            skillName: 'Npm Run Build',
          },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result[0].data.skillId).toBe('npm-run-build');
        expect(result[0].data.skillName).toBe('Npm Run Build');
      });

      it('extracts agent node data correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'agent1',
            type: 'agent',
            label: 'Code Agent',
            position: { x: 0, y: 0 },
            agentId: 'code-agent',
            agentName: 'Code Agent',
            systemPrompt: 'You are a coding assistant',
            model: 'claude-3-opus',
            maxTurns: 10,
            temperature: 0.7,
            allowedTools: ['Read', 'Edit'],
            handoffs: [{ targetAgentId: 'review-agent' }],
          },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result[0].data.agentId).toBe('code-agent');
        expect(result[0].data.agentName).toBe('Code Agent');
        expect(result[0].data.systemPrompt).toBe('You are a coding assistant');
        expect(result[0].data.model).toBe('claude-3-opus');
        expect(result[0].data.maxTurns).toBe(10);
        expect(result[0].data.temperature).toBe(0.7);
        expect(result[0].data.allowedTools).toEqual(['Read', 'Edit']);
        expect(result[0].data.handoffs).toEqual([{ targetAgentId: 'review-agent' }]);
      });

      it('extracts conditional node data correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'cond1',
            type: 'conditional',
            label: 'Check Status',
            position: { x: 0, y: 0 },
            expression: 'status === "success"',
            branches: [{ condition: 'true', targetNodeId: 'success' }],
            defaultBranch: 'failure',
          },
        ];

        const result = toReactFlowNodes(nodes, { useCompactNodes: false });

        expect(result[0].data.expression).toBe('status === "success"');
        expect(result[0].data.branches).toEqual([{ condition: 'true', targetNodeId: 'success' }]);
        expect(result[0].data.defaultBranch).toBe('failure');
      });

      it('extracts loop node data correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'loop1',
            type: 'loop',
            label: 'Process Items',
            position: { x: 0, y: 0 },
            iteratorVariable: 'item',
            collection: 'items',
            maxIterations: 100,
            breakCondition: 'item.done',
            bodyNodeIds: ['process1', 'process2'],
          },
        ];

        const result = toReactFlowNodes(nodes, { useCompactNodes: false });

        expect(result[0].data.iteratorVariable).toBe('item');
        expect(result[0].data.collection).toBe('items');
        expect(result[0].data.maxIterations).toBe(100);
        expect(result[0].data.breakCondition).toBe('item.done');
        expect(result[0].data.bodyNodeIds).toEqual(['process1', 'process2']);
      });

      it('extracts parallel node data correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'parallel1',
            type: 'parallel',
            label: 'Run Tasks',
            position: { x: 0, y: 0 },
            branchNodeIds: ['task1', 'task2', 'task3'],
            waitForAll: true,
            maxConcurrency: 2,
          },
        ];

        const result = toReactFlowNodes(nodes, { useCompactNodes: false });

        expect(result[0].data.branchNodeIds).toEqual(['task1', 'task2', 'task3']);
        expect(result[0].data.waitForAll).toBe(true);
        expect(result[0].data.maxConcurrency).toBe(2);
      });

      it('extracts start node inputs correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'start',
            type: 'start',
            label: 'Start',
            position: { x: 0, y: 0 },
            inputs: [
              { name: 'codespaceId', type: 'string', required: true },
              { name: 'debug', type: 'boolean', required: false, defaultValue: false },
            ],
          },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result[0].data.inputs).toHaveLength(2);
        expect(result[0].data.inputs[0]).toEqual({
          name: 'codespaceId',
          type: 'string',
          required: true,
        });
      });

      it('extracts end node outputs correctly', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'end',
            type: 'end',
            label: 'End',
            position: { x: 0, y: 0 },
            outputs: [
              { name: 'result', type: 'object', sourceNodeId: 'process1', sourceOutput: 'data' },
            ],
          },
        ];

        const result = toReactFlowNodes(nodes);

        expect(result[0].data.outputs).toHaveLength(1);
        expect(result[0].data.outputs[0]).toEqual({
          name: 'result',
          type: 'object',
          sourceNodeId: 'process1',
          sourceOutput: 'data',
        });
      });

      it('falls back to original type for node types without compact variants', async () => {
        const { toReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          {
            id: 'cond1',
            type: 'conditional',
            label: 'Check',
            position: { x: 0, y: 0 },
            expression: 'true',
            branches: [{ condition: 'true', targetNodeId: 'next' }],
          },
        ];

        const result = toReactFlowNodes(nodes, { useCompactNodes: true });

        // Conditional has no compact variant, falls back to original type
        expect(result[0].type).toBe('conditional');
      });
    });

    describe('toReactFlowEdges', () => {
      it('converts workflow edges to ReactFlow edges', async () => {
        const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

        const edges: WorkflowEdge[] = [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'task1' },
          {
            id: 'e2',
            type: 'dataflow',
            sourceNodeId: 'task1',
            targetNodeId: 'task2',
            sourceOutput: 'result',
            targetInput: 'data',
          },
          { id: 'e3', type: 'sequential', sourceNodeId: 'task2', targetNodeId: 'end' },
        ];

        const result = toReactFlowEdges(edges);

        expect(result).toHaveLength(3);
        expect(result[0].source).toBe('start');
        expect(result[0].target).toBe('task1');
        expect(result[0].type).toBe('sequential');
      });

      it('extracts handoff edge data correctly', async () => {
        const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

        const edges: WorkflowEdge[] = [
          {
            id: 'e1',
            type: 'handoff',
            sourceNodeId: 'agent1',
            targetNodeId: 'agent2',
            context: { task: 'review' },
            preserveHistory: true,
            label: 'Hand off to reviewer',
          } as HandoffEdge,
        ];

        const result = toReactFlowEdges(edges);

        expect(result[0].data.edgeType).toBe('handoff');
        expect(result[0].data.context).toEqual({ task: 'review' });
        expect(result[0].data.preserveHistory).toBe(true);
        expect(result[0].label).toBe('Hand off to reviewer');
      });

      it('extracts dataflow edge data correctly', async () => {
        const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

        const edges: WorkflowEdge[] = [
          {
            id: 'e1',
            type: 'dataflow',
            sourceNodeId: 'task1',
            targetNodeId: 'task2',
            sourceOutput: 'result',
            targetInput: 'data',
            transform: 'JSON.parse',
          } as DataflowEdge,
        ];

        const result = toReactFlowEdges(edges);

        expect(result[0].data.sourceOutput).toBe('result');
        expect(result[0].data.targetInput).toBe('data');
        expect(result[0].data.transform).toBe('JSON.parse');
      });

      it('extracts conditional edge data correctly', async () => {
        const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

        const edges: WorkflowEdge[] = [
          {
            id: 'e1',
            type: 'conditional',
            sourceNodeId: 'check',
            targetNodeId: 'success',
            condition: 'status === "ok"',
            priority: 1,
          } as ConditionalEdge,
        ];

        const result = toReactFlowEdges(edges);

        expect(result[0].data.condition).toBe('status === "ok"');
        expect(result[0].data.priority).toBe(1);
      });

      it('includes metadata in edge data', async () => {
        const { toReactFlowEdges } = await import('@/lib/workflow-dsl/layout');

        const edges: WorkflowEdge[] = [
          {
            id: 'e1',
            type: 'sequential',
            sourceNodeId: 'start',
            targetNodeId: 'end',
            metadata: { custom: 'value' },
          } as SequentialEdge,
        ];

        const result = toReactFlowEdges(edges);

        expect(result[0].data.metadata).toEqual({ custom: 'value' });
      });
    });

    describe('fromReactFlowNodes', () => {
      it('converts ReactFlow nodes back to workflow nodes with updated positions', async () => {
        const { fromReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const originalNodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          {
            id: 'task1',
            type: 'skill',
            label: 'Task 1',
            position: { x: 0, y: 100 },
            skillId: 'npm-test',
            skillName: 'Npm Test',
            description: 'Run tests',
          },
        ];

        const reactFlowNodes: ReactFlowNode[] = [
          { id: 'start', type: 'compactStart', position: { x: 50, y: 25 }, data: {} },
          { id: 'task1', type: 'compactSkill', position: { x: 50, y: 150 }, data: {} },
        ];

        const result = fromReactFlowNodes(reactFlowNodes, originalNodes);

        expect(result[0].position).toEqual({ x: 50, y: 25 });
        expect(result[0].type).toBe('start'); // Original type preserved
        expect(result[1].position).toEqual({ x: 50, y: 150 });
        expect(result[1].skillId).toBe('npm-test'); // Original properties preserved
        expect(result[1].description).toBe('Run tests');
      });

      it('throws error when original node is not found', async () => {
        const { fromReactFlowNodes } = await import('@/lib/workflow-dsl/layout');

        const originalNodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
        ];

        const reactFlowNodes: ReactFlowNode[] = [
          { id: 'nonexistent', type: 'compactStart', position: { x: 50, y: 25 }, data: {} },
        ];

        expect(() => fromReactFlowNodes(reactFlowNodes, originalNodes)).toThrow(
          'Original node not found for id: nonexistent'
        );
      });
    });

    describe('layoutWorkflowForReactFlow', () => {
      it('applies layout and converts to ReactFlow format in one call', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [
            { id: 'start', x: 0, y: 0 },
            { id: 'end', x: 0, y: 100 },
          ],
        });

        const { layoutWorkflowForReactFlow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } },
        ];

        const edges: WorkflowEdge[] = [
          { id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
        ];

        const result = await layoutWorkflowForReactFlow(nodes, edges);

        expect(result.nodes).toHaveLength(2);
        expect(result.edges).toHaveLength(1);
        expect(result.nodes[0].type).toBe('compactStart');
        expect(result.nodes[1].type).toBe('compactEnd');
      });

      it('respects useCompactNodes option', async () => {
        mockLayoutFn.mockResolvedValue({
          children: [{ id: 'start', x: 0, y: 0 }],
        });

        const { layoutWorkflowForReactFlow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
        ];

        const result = await layoutWorkflowForReactFlow(nodes, [], { useCompactNodes: false });

        expect(result.nodes[0].type).toBe('start');
      });
    });

    describe('ELK Layout Options', () => {
      it('maps direction options correctly', async () => {
        mockLayoutFn.mockResolvedValue({ children: [{ id: 'n1', x: 0, y: 0 }] });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'n1', type: 'start', label: 'N1', position: { x: 0, y: 0 } },
        ];

        const directions = ['DOWN', 'UP', 'LEFT', 'RIGHT'] as const;
        for (const direction of directions) {
          await layoutWorkflow(nodes, [], { direction });
          expect(mockLayoutFn).toHaveBeenCalledWith(
            expect.objectContaining({
              layoutOptions: expect.objectContaining({
                'elk.direction': direction,
              }),
            })
          );
        }
      });

      it('maps algorithm options correctly', async () => {
        mockLayoutFn.mockResolvedValue({ children: [{ id: 'n1', x: 0, y: 0 }] });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'n1', type: 'start', label: 'N1', position: { x: 0, y: 0 } },
        ];

        const algorithms = ['layered', 'force', 'box', 'random'] as const;
        for (const algorithm of algorithms) {
          await layoutWorkflow(nodes, [], { algorithm });
          expect(mockLayoutFn).toHaveBeenCalledWith(
            expect.objectContaining({
              layoutOptions: expect.objectContaining({
                'elk.algorithm': algorithm,
              }),
            })
          );
        }
      });

      it('maps edge routing options correctly', async () => {
        mockLayoutFn.mockResolvedValue({ children: [{ id: 'n1', x: 0, y: 0 }] });

        const { layoutWorkflow } = await import('@/lib/workflow-dsl/layout');

        const nodes: WorkflowNode[] = [
          { id: 'n1', type: 'start', label: 'N1', position: { x: 0, y: 0 } },
        ];

        const routings = ['ORTHOGONAL', 'POLYLINE', 'SPLINES'] as const;
        for (const edgeRouting of routings) {
          await layoutWorkflow(nodes, [], { edgeRouting });
          expect(mockLayoutFn).toHaveBeenCalledWith(
            expect.objectContaining({
              layoutOptions: expect.objectContaining({
                'elk.edgeRouting': edgeRouting,
              }),
            })
          );
        }
      });
    });
  });

  // =============================================================================
  // AI PROMPTS MODULE TESTS
  // =============================================================================

  describe('AI Prompts Module', () => {
    describe('WORKFLOW_GENERATION_SYSTEM_PROMPT', () => {
      it('contains core workflow generation instructions', async () => {
        const { WORKFLOW_GENERATION_SYSTEM_PROMPT } = await import('@/lib/workflow-dsl/ai-prompts');

        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('workflow DSL generator');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('Node Types');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('Edge Types');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('start');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('end');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('skill');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('agent');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('conditional');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('loop');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('parallel');
      });

      it('includes JSON output format specification', async () => {
        const { WORKFLOW_GENERATION_SYSTEM_PROMPT } = await import('@/lib/workflow-dsl/ai-prompts');

        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"nodes"');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"edges"');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('aiGenerated');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('aiConfidence');
      });

      it('includes skill recognition guidance', async () => {
        const { WORKFLOW_GENERATION_SYSTEM_PROMPT } = await import('@/lib/workflow-dsl/ai-prompts');

        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('Skill Recognition');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('/speckit.specify');
        expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('/commit');
      });
    });

    describe('createWorkflowAnalysisPrompt', () => {
      it('generates prompt with template name and content', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: '1. Run tests\n2. Deploy',
        });

        expect(prompt).toContain('Test Template');
        expect(prompt).toContain('1. Run tests');
        expect(prompt).toContain('2. Deploy');
      });

      it('includes description when provided', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          description: 'A template for testing workflows',
          content: 'Test content',
        });

        expect(prompt).toContain('A template for testing workflows');
      });

      it('includes available skills section when skills provided', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: 'Test content',
          skills: [
            { id: 'review-pr', name: 'Review PR', description: 'Review pull requests' },
            { id: 'commit', name: 'Commit', description: 'Create commits' },
          ],
        });

        expect(prompt).toContain('Available Skills');
        expect(prompt).toContain('Review PR');
        expect(prompt).toContain('review-pr');
        expect(prompt).toContain('Review pull requests');
        expect(prompt).toContain('Commit');
      });

      it('includes available skills section when commands provided', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: 'Test content',
          commands: [
            { name: 'build', command: 'npm run build', description: 'Build the project' },
            { name: 'test', command: 'npm test', description: 'Run tests' },
          ],
        });

        expect(prompt).toContain('Available Skills');
        expect(prompt).toContain('build');
        expect(prompt).toContain('npm run build');
        expect(prompt).toContain('Build the project');
      });

      it('includes available agents section when agents provided', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: 'Test content',
          agents: [
            {
              id: 'code-agent',
              name: 'Code Agent',
              description: 'Writes code',
              systemPrompt: 'You are a helpful coding assistant that writes clean code...',
            },
          ],
        });

        expect(prompt).toContain('Available Agents');
        expect(prompt).toContain('Code Agent');
        expect(prompt).toContain('code-agent');
        expect(prompt).toContain('Writes code');
        expect(prompt).toContain('System prompt:');
      });

      it('includes known skill names for cross-referencing', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: 'Test content',
          knownSkillNames: ['speckit.specify', 'speckit.plan', 'commit'],
          knownCommandNames: ['gh-pr-create', 'npm-build'],
        });

        expect(prompt).toContain('KNOWN SKILLS');
        expect(prompt).toContain('/speckit.specify');
        expect(prompt).toContain('/speckit.plan');
        expect(prompt).toContain('/commit');
        expect(prompt).toContain('/gh-pr-create');
        expect(prompt).toContain('/npm-build');
      });

      it('includes analysis instructions', async () => {
        const { createWorkflowAnalysisPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowAnalysisPrompt({
          name: 'Test Template',
          content: 'Test content',
        });

        expect(prompt).toContain('Instructions');
        expect(prompt).toContain('CRITICAL RULES');
        expect(prompt).toContain('Return ONLY the JSON');
      });
    });

    describe('createWorkflowValidationPrompt', () => {
      it('generates validation prompt with workflow JSON', async () => {
        const { createWorkflowValidationPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const workflow = {
          nodes: [{ id: 'start', type: 'start', label: 'Start' }],
          edges: [],
        };

        const prompt = createWorkflowValidationPrompt(workflow);

        expect(prompt).toContain('Workflow to Validate');
        expect(prompt).toContain('"id": "start"');
        expect(prompt).toContain('"type": "start"');
      });

      it('includes structural validation instructions', async () => {
        const { createWorkflowValidationPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowValidationPrompt({ nodes: [], edges: [] });

        expect(prompt).toContain('Check structural validity');
        expect(prompt).toContain('start node');
        expect(prompt).toContain('end node');
        expect(prompt).toContain('edge references');
      });

      it('includes node configuration validation instructions', async () => {
        const { createWorkflowValidationPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowValidationPrompt({ nodes: [], edges: [] });

        expect(prompt).toContain('Validate node configurations');
        expect(prompt).toContain('Skill nodes');
        expect(prompt).toContain('Agent nodes');
      });

      it('includes expected response format', async () => {
        const { createWorkflowValidationPrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowValidationPrompt({ nodes: [], edges: [] });

        expect(prompt).toContain('"valid"');
        expect(prompt).toContain('"errors"');
        expect(prompt).toContain('"warnings"');
        expect(prompt).toContain('"suggestions"');
        expect(prompt).toContain('"correctedWorkflow"');
      });
    });

    describe('createWorkflowFromDescriptionPrompt', () => {
      it('generates prompt with natural language description', async () => {
        const { createWorkflowFromDescriptionPrompt } = await import(
          '@/lib/workflow-dsl/ai-prompts'
        );

        const description =
          'Create a workflow that runs tests, reviews code, and deploys to production';
        const prompt = createWorkflowFromDescriptionPrompt(description);

        expect(prompt).toContain('Workflow Description');
        expect(prompt).toContain(description);
      });

      it('includes parsing instructions', async () => {
        const { createWorkflowFromDescriptionPrompt } = await import(
          '@/lib/workflow-dsl/ai-prompts'
        );

        const prompt = createWorkflowFromDescriptionPrompt('Test workflow');

        expect(prompt).toContain('Parse the requirements');
        expect(prompt).toContain('Identify the main operations');
        expect(prompt).toContain('conditional logic');
        expect(prompt).toContain('parallel operations');
      });

      it('includes node creation guidance', async () => {
        const { createWorkflowFromDescriptionPrompt } = await import(
          '@/lib/workflow-dsl/ai-prompts'
        );

        const prompt = createWorkflowFromDescriptionPrompt('Test workflow');

        expect(prompt).toContain('Create appropriate nodes');
        expect(prompt).toContain('skill nodes');
        expect(prompt).toContain('agent nodes');
      });

      it('includes confidence scoring guidance', async () => {
        const { createWorkflowFromDescriptionPrompt } = await import(
          '@/lib/workflow-dsl/ai-prompts'
        );

        const prompt = createWorkflowFromDescriptionPrompt('Test workflow');

        expect(prompt).toContain('Set confidence appropriately');
        expect(prompt).toContain('Higher confidence');
        expect(prompt).toContain('Lower confidence');
      });
    });

    describe('createWorkflowMergePrompt', () => {
      it('generates merge prompt with multiple workflows', async () => {
        const { createWorkflowMergePrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const workflows = [
          { name: 'Build', workflow: { nodes: [{ id: 'build' }], edges: [] } },
          { name: 'Test', workflow: { nodes: [{ id: 'test' }], edges: [] } },
        ];

        const prompt = createWorkflowMergePrompt(workflows, 'sequential');

        expect(prompt).toContain('Workflows to Merge');
        expect(prompt).toContain('Workflow 1: Build');
        expect(prompt).toContain('Workflow 2: Test');
        expect(prompt).toContain('"id": "build"');
        expect(prompt).toContain('"id": "test"');
      });

      it('includes sequential merge strategy instructions', async () => {
        const { createWorkflowMergePrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowMergePrompt([{ name: 'W1', workflow: {} }], 'sequential');

        expect(prompt).toContain('Merge Strategy: sequential');
        expect(prompt).toContain('end-to-end');
        expect(prompt).toContain('completes before the next begins');
      });

      it('includes parallel merge strategy instructions', async () => {
        const { createWorkflowMergePrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowMergePrompt([{ name: 'W1', workflow: {} }], 'parallel');

        expect(prompt).toContain('Merge Strategy: parallel');
        expect(prompt).toContain('concurrently');
        expect(prompt).toContain('waiting for all to complete');
      });

      it('includes conditional merge strategy instructions', async () => {
        const { createWorkflowMergePrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowMergePrompt([{ name: 'W1', workflow: {} }], 'conditional');

        expect(prompt).toContain('Merge Strategy: conditional');
        expect(prompt).toContain('conditional at the start');
        expect(prompt).toContain('based on conditions');
      });

      it('includes merge instructions', async () => {
        const { createWorkflowMergePrompt } = await import('@/lib/workflow-dsl/ai-prompts');

        const prompt = createWorkflowMergePrompt([{ name: 'W1', workflow: {} }], 'sequential');

        expect(prompt).toContain('Create a new merged workflow');
        expect(prompt).toContain('Generate unique IDs');
        expect(prompt).toContain('Remove redundant start/end nodes');
        expect(prompt).toContain('Recalculate positions');
      });
    });
  });

  // =============================================================================
  // TYPES MODULE TESTS
  // =============================================================================

  describe('Types Module', () => {
    describe('Schema Validation', () => {
      it('validates node type enum', async () => {
        const { nodeTypeSchema } = await import('@/lib/workflow-dsl/types');

        expect(() => nodeTypeSchema.parse('skill')).not.toThrow();
        expect(() => nodeTypeSchema.parse('agent')).not.toThrow();
        expect(() => nodeTypeSchema.parse('conditional')).not.toThrow();
        expect(() => nodeTypeSchema.parse('loop')).not.toThrow();
        expect(() => nodeTypeSchema.parse('parallel')).not.toThrow();
        expect(() => nodeTypeSchema.parse('start')).not.toThrow();
        expect(() => nodeTypeSchema.parse('end')).not.toThrow();
        expect(() => nodeTypeSchema.parse('invalid')).toThrow();
      });

      it('validates edge type enum', async () => {
        const { edgeTypeSchema } = await import('@/lib/workflow-dsl/types');

        expect(() => edgeTypeSchema.parse('sequential')).not.toThrow();
        expect(() => edgeTypeSchema.parse('handoff')).not.toThrow();
        expect(() => edgeTypeSchema.parse('dataflow')).not.toThrow();
        expect(() => edgeTypeSchema.parse('conditional')).not.toThrow();
        expect(() => edgeTypeSchema.parse('invalid')).toThrow();
      });

      it('validates position schema', async () => {
        const { positionSchema } = await import('@/lib/workflow-dsl/types');

        expect(() => positionSchema.parse({ x: 0, y: 0 })).not.toThrow();
        expect(() => positionSchema.parse({ x: 100.5, y: -50 })).not.toThrow();
        expect(() => positionSchema.parse({ x: 'invalid', y: 0 })).toThrow();
        expect(() => positionSchema.parse({ x: 0 })).toThrow();
      });

      it('validates skill node schema', async () => {
        const { skillNodeSchema } = await import('@/lib/workflow-dsl/types');

        const validNode = {
          id: 'skill1',
          type: 'skill',
          label: 'Review PR',
          position: { x: 0, y: 0 },
          skillId: 'review-pr',
          skillName: 'PR Review',
        };

        expect(() => skillNodeSchema.parse(validNode)).not.toThrow();
        expect(() => skillNodeSchema.parse({ ...validNode, skillId: '' })).toThrow();
        expect(() => skillNodeSchema.parse({ ...validNode, skillName: '' })).toThrow();
      });

      it('validates agent node schema', async () => {
        const { agentNodeSchema } = await import('@/lib/workflow-dsl/types');

        const validNode = {
          id: 'agent1',
          type: 'agent',
          label: 'Code Agent',
          position: { x: 0, y: 0 },
          agentId: 'code-agent',
          agentName: 'Code Agent',
        };

        expect(() => agentNodeSchema.parse(validNode)).not.toThrow();
        expect(() => agentNodeSchema.parse({ ...validNode, temperature: 1.5 })).toThrow();
        expect(() => agentNodeSchema.parse({ ...validNode, temperature: -0.1 })).toThrow();
      });

      it('validates dataflow edge schema', async () => {
        const { dataflowEdgeSchema } = await import('@/lib/workflow-dsl/types');

        const validEdge = {
          id: 'e1',
          type: 'dataflow',
          sourceNodeId: 'node1',
          targetNodeId: 'node2',
          sourceOutput: 'result',
          targetInput: 'data',
        };

        expect(() => dataflowEdgeSchema.parse(validEdge)).not.toThrow();
        expect(() => dataflowEdgeSchema.parse({ ...validEdge, sourceOutput: '' })).toThrow();
      });

      it('validates workflow schema', async () => {
        const { workflowSchema } = await import('@/lib/workflow-dsl/types');

        const validWorkflow = {
          id: 'wf1',
          name: 'Test Workflow',
          nodes: [],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        expect(() => workflowSchema.parse(validWorkflow)).not.toThrow();
        expect(() => workflowSchema.parse({ ...validWorkflow, name: '' })).toThrow();
        expect(() => workflowSchema.parse({ ...validWorkflow, aiConfidence: 101 })).toThrow();
        expect(() => workflowSchema.parse({ ...validWorkflow, aiConfidence: -1 })).toThrow();
      });
    });

    describe('validateWorkflowStructure', () => {
      it('validates workflow with one start and one end node', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Valid Workflow',
          nodes: [
            { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [{ id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' }],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('returns error when no start node exists', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [{ id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } }],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Workflow must have exactly one start node');
      });

      it('returns error when multiple start nodes exist', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [
            { id: 'start1', type: 'start', label: 'Start 1', position: { x: 0, y: 0 } },
            { id: 'start2', type: 'start', label: 'Start 2', position: { x: 100, y: 0 } },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('2 start nodes');
      });

      it('returns error when no end node exists', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [{ id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } }],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Workflow must have at least one end node');
      });

      it('returns error for edges referencing non-existent nodes', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [
            { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [
            { id: 'e1', type: 'sequential', sourceNodeId: 'start', targetNodeId: 'missing' },
            { id: 'e2', type: 'sequential', sourceNodeId: 'missing', targetNodeId: 'end' },
          ],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('non-existent source node'))).toBe(true);
        expect(result.errors.some((e) => e.includes('non-existent target node'))).toBe(true);
      });

      it('validates loop body node references', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [
            { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
            {
              id: 'loop1',
              type: 'loop',
              label: 'Loop',
              position: { x: 0, y: 50 },
              iteratorVariable: 'item',
              collection: 'items',
              bodyNodeIds: ['missing1', 'missing2'],
            },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('non-existent body node'))).toBe(true);
      });

      it('validates parallel branch node references', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [
            { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
            {
              id: 'parallel1',
              type: 'parallel',
              label: 'Parallel',
              position: { x: 0, y: 50 },
              branchNodeIds: ['missing1'],
              waitForAll: true,
            },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('non-existent branch node'))).toBe(true);
      });

      it('validates conditional branch target node references', async () => {
        const { validateWorkflowStructure } = await import('@/lib/workflow-dsl/types');

        const workflow: Workflow = {
          id: 'wf1',
          name: 'Invalid Workflow',
          nodes: [
            { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
            {
              id: 'cond1',
              type: 'conditional',
              label: 'Check',
              position: { x: 0, y: 50 },
              expression: 'true',
              branches: [{ condition: 'true', targetNodeId: 'missing' }],
              defaultBranch: 'also_missing',
            },
            { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 100 } },
          ],
          edges: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const result = validateWorkflowStructure(workflow);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('non-existent target node'))).toBe(true);
        expect(result.errors.some((e) => e.includes('non-existent default branch'))).toBe(true);
      });
    });

    describe('Factory Helpers', () => {
      it('createNodeId generates unique IDs with prefix', async () => {
        const { createNodeId } = await import('@/lib/workflow-dsl/types');

        const id1 = createNodeId('skill');
        const id2 = createNodeId('skill');
        const id3 = createNodeId();

        expect(id1).toMatch(/^skill_/);
        expect(id2).toMatch(/^skill_/);
        expect(id3).toMatch(/^node_/);
        expect(id1).not.toBe(id2);
      });

      it('createEdgeId generates unique IDs with source and target', async () => {
        const { createEdgeId } = await import('@/lib/workflow-dsl/types');

        const id1 = createEdgeId('start', 'end');
        const id2 = createEdgeId('start', 'end');

        expect(id1).toMatch(/^edge_start_end_/);
        expect(id1).not.toBe(id2);
      });
    });
  });
});
