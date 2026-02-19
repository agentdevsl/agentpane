import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { TopologyGraph } from '@/lib/topology/types';
import { getElk } from '@/lib/workflow-dsl/layout';

const NODE_WIDTH = 120;
const NODE_HEIGHT = 100;

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

  const rfNodes: ReactFlowNode[] = children
    .map((child: ElkNode) => {
      const graphNode = graph.nodes.find((n) => n.id === child.id);
      if (!graphNode) return undefined;
      return {
        id: child.id,
        type: 'agentNode' as const,
        position: { x: child.x ?? 0, y: child.y ?? 0 },
        data: {
          name: graphNode.name,
          role: graphNode.role,
          status: graphNode.status,
          progress: graphNode.progress,
          decisions: graphNode.decisions,
          nodeIndex: graph.nodes.indexOf(graphNode),
        },
        draggable: false,
        connectable: false,
      };
    })
    .filter((n: ReactFlowNode | undefined): n is ReactFlowNode => n !== undefined);

  const rfEdges: ReactFlowEdge[] = graph.edges.map((e) => {
    const sourceNode = graph.nodes.find((n) => n.id === e.sourceId);
    const targetNode = graph.nodes.find((n) => n.id === e.targetId);
    return {
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'agentEdge',
      data: {
        sourceStatus: sourceNode?.status ?? 'queued',
        targetStatus: targetNode?.status ?? 'queued',
      },
    };
  });

  return { nodes: rfNodes, edges: rfEdges };
}
