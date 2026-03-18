import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { TopologyGraph } from '@/lib/topology/types';
import { getElk } from '@/lib/workflow-dsl/layout';
import type { AgentNodeData } from './nodes/agent-node';

const NODE_WIDTH = 120;
const NODE_HEIGHT = 145;

export async function layoutTopology(
  graph: TopologyGraph
): Promise<{ nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const elk = await getElk();
  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '160',
      'elk.layered.spacing.nodeNodeBetweenLayers': '130',
      'elk.edgeRouting': 'SPLINES',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.contentAlignment': 'H_CENTER V_TOP',
      'elk.layered.mergeEdges': 'false',
      'elk.spacing.edgeNode': '80',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '80',
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      properties: {
        'org.eclipse.elk.portConstraints': 'FIXED_POS',
      },
      ports: [
        {
          id: `${n.id}__target`,
          properties: { 'org.eclipse.elk.port.side': 'NORTH' },
          x: NODE_WIDTH / 2,
          y: 0,
          width: 1,
          height: 1,
        },
        {
          id: `${n.id}__source`,
          properties: { 'org.eclipse.elk.port.side': 'SOUTH' },
          x: NODE_WIDTH / 2,
          y: NODE_HEIGHT,
          width: 1,
          height: 1,
        },
      ],
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      sources: [`${e.sourceId}__source`],
      targets: [`${e.targetId}__target`],
    })),
  };

  const layouted = await elk.layout(elkGraph);
  const children = layouted.children ?? [];

  const nodeById = new Map(graph.nodes.map((n, i) => [n.id, { node: n, index: i }]));

  const rfNodes: ReactFlowNode[] = children
    .map((child: ElkNode) => {
      const entry = nodeById.get(child.id);
      if (!entry) return undefined;
      return {
        id: child.id,
        type: 'agentNode' as const,
        position: { x: child.x ?? 0, y: child.y ?? 0 },
        data: {
          name: entry.node.name,
          role: entry.node.role,
          status: entry.node.status,
          progress: entry.node.progress,
          decisions: entry.node.decisions,
          tokens: entry.node.tokens,
          cost: entry.node.cost,
          turns: entry.node.turns,
          nodeIndex: entry.index,
        } satisfies AgentNodeData,
        draggable: false,
        connectable: false,
      };
    })
    .filter((n: ReactFlowNode | undefined): n is ReactFlowNode => n !== undefined);

  const rfEdges: ReactFlowEdge[] = graph.edges.map((e) => {
    const sourceEntry = nodeById.get(e.sourceId);
    const targetEntry = nodeById.get(e.targetId);
    return {
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'agentEdge',
      data: {
        sourceStatus: sourceEntry?.node.status ?? 'queued',
        targetStatus: targetEntry?.node.status ?? 'queued',
      },
    };
  });

  return { nodes: rfNodes, edges: rfEdges };
}
