import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { TopologyGraph } from '@/lib/topology/types';
import { getElk } from '@/lib/workflow-dsl/layout';
import type { AgentNodeData } from './nodes/agent-node';
import type { SkillNodeData } from './nodes/skill-node';

const NODE_WIDTH = 170;
// 170 matches the actual rendered height of AgentNode (SVG viewBox 145 +
// extra margin for the metrics row). Using a value smaller than the rendered
// height makes ELK pack layers too tightly and adjacent rows overlap.
const NODE_HEIGHT = 170;
const SKILL_NODE_WIDTH = 200;
const SKILL_NODE_HEIGHT = 50;

export async function layoutTopology(
  graph: TopologyGraph
): Promise<{ nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const elk = await getElk();

  // Build ELK node for a topology node. mrtree doesn't use port constraints —
  // it routes edges from node centers — so we just give ELK the dimensions.
  function makeElkNode(n: (typeof graph.nodes)[number]): ElkNode {
    const isSkill = n.type === 'skill';
    return {
      id: n.id,
      width: isSkill ? SKILL_NODE_WIDTH : NODE_WIDTH,
      height: isSkill ? SKILL_NODE_HEIGHT : NODE_HEIGHT,
    };
  }

  // mrtree handles sibling layout natively — concurrent-sibling grouping
  // (the `group` field on TopologyNode) is a layered-algorithm artifact and
  // would create compound nodes that mrtree can't route edges through.
  const topChildren = graph.nodes.map(makeElkNode);

  // Build a spanning tree (BFS from roots) so ELK's `mrtree` algorithm —
  // which only handles strict trees, not DAGs with merges — gets a clean
  // tree structure to lay out. The merge edges (e.g. multiple research
  // nodes pointing into a synthesizer) are still rendered by ReactFlow on
  // top of the layout so users see the full topology.
  const incomingCount = new Map<string, number>();
  for (const e of graph.edges) {
    incomingCount.set(e.targetId, (incomingCount.get(e.targetId) ?? 0) + 1);
  }
  const treeRootIds = graph.nodes
    .filter((n) => (incomingCount.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const visitedTree = new Set<string>(treeRootIds);
  const treeEdges: typeof graph.edges = [];
  const queue: string[] = [...treeRootIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const e of graph.edges) {
      if (e.sourceId === current && !visitedTree.has(e.targetId)) {
        visitedTree.add(e.targetId);
        treeEdges.push(e);
        queue.push(e.targetId);
      }
    }
  }

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'mrtree',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '50',
      'elk.spacing.edgeNode': '20',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
      'elk.mrtree.weighting': 'CONSTRAINT',
      'elk.mrtree.searchOrder': 'DFS',
    },
    children: topChildren,
    edges: treeEdges.map((e) => ({
      id: e.id,
      sources: [e.sourceId],
      targets: [e.targetId],
    })),
  };

  const layouted = await elk.layout(elkGraph);

  const nodeById = new Map(graph.nodes.map((n, i) => [n.id, { node: n, index: i }]));

  const flatChildren: Array<{ id: string; x: number; y: number }> = (layouted.children ?? []).map(
    (child: ElkNode) => ({ id: child.id, x: child.x ?? 0, y: child.y ?? 0 })
  );

  const rfNodes: ReactFlowNode[] = flatChildren
    .map((child) => {
      const entry = nodeById.get(child.id);
      if (!entry) return null;
      const isSkill = entry.node.type === 'skill';
      if (isSkill) {
        return {
          id: child.id,
          type: 'skillNode' as const,
          position: { x: child.x, y: child.y },
          data: {
            name: entry.node.name,
            skillId: entry.node.skillId,
          } satisfies SkillNodeData,
          draggable: false,
          connectable: false,
        };
      }
      return {
        id: child.id,
        type: 'agentNode' as const,
        position: { x: child.x, y: child.y },
        data: {
          name: entry.node.name,
          role: entry.node.role,
          agentType: entry.node.agentType,
          status: entry.node.status,
          progress: entry.node.progress,
          decisions: entry.node.decisions,
          tokens: entry.node.tokens,
          cost: entry.node.cost,
          turns: entry.node.turns,
          nodeIndex: entry.index,
          skillId: entry.node.skillId,
          skillName: entry.node.skillName,
          skillCalls: entry.node.skillCalls,
          agentMeta: entry.node.agentMeta,
          phase: entry.node.phase,
        } satisfies AgentNodeData,
        draggable: false,
        connectable: false,
      };
    })
    .filter(Boolean) as ReactFlowNode[];

  const rfEdges: ReactFlowEdge[] = graph.edges.map((e) => {
    const sourceEntry = nodeById.get(e.sourceId);
    const targetEntry = nodeById.get(e.targetId);
    const isSkillEdge = targetEntry?.node.type === 'skill';
    if (isSkillEdge) {
      return {
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'skillEdge',
        data: {},
      };
    }
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
