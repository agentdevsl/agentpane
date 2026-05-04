import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { TopologyGraph } from '@/lib/topology/types';
import { getElk } from '@/lib/workflow-dsl/layout';
import type { AgentNodeData } from './nodes/agent-node';
import type { SkillNodeData } from './nodes/skill-node';

// Must match the actual container sizes in AgentNode/SkillNode — if ELK
// thinks a node is wider than it really is, mrtree centers parent above
// child using ELK's idea of the width and the rendered centers no longer
// line up (edges land off-center).
const NODE_WIDTH = 120;
const NODE_HEIGHT = 145;
const SKILL_NODE_WIDTH = 160;
const SKILL_NODE_HEIGHT = 50;

/**
 * Agent types that are *not* worth grouping on visually. These are the
 * SDK's catch-all fallbacks emitted when the orchestrator invokes the
 * Agent tool without a `subagent_type` (or before the registry was loaded
 * — see `agent-runner` history). Boxing them would lump unrelated calls
 * together under a misleading label. `local_bash` and `Explore` are
 * intentionally NOT in this list — they are real, distinct built-in
 * helpers and deserve their own clusters.
 */
const GENERIC_AGENT_TYPES = new Set(['local_agent', 'general-purpose']);

/**
 * Pixel padding around the bounding box of a same-type cluster.
 *
 * `GROUP_BOX_TOP` is larger to leave room for the type label without it
 * sitting on top of the first node. The horizontal padding is kept small
 * so adjacent clusters under the same parent don't overlap (ELK's
 * `nodeNode` spacing is 60px; with `GROUP_BOX_SIDE = 10` each side we
 * leave a clean 40px channel between cluster boundaries).
 */
const GROUP_BOX_TOP = 24;
const GROUP_BOX_SIDE = 10;
const GROUP_BOX_BOTTOM = 14;
/**
 * Minimum number of sibling nodes that share an agent_type to draw a box.
 * 1 means even singletons get a labelled box, which is visually noisy
 * for one-off Design / Synth nodes; 2+ keeps boxes only for actual fan-
 * outs. Tunable as a hint to the user what the workflow stage is.
 */
const GROUP_MIN_SIZE = 1;

export interface TopologyGroupBox {
  /** Stable id derived from parent + agent_type, safe for React keys. */
  id: string;
  /** SDK-resolved agent_type used as the cluster label. */
  agentType: string;
  /** Number of nodes inside this cluster. */
  nodeCount: number;
  /** Top-left corner in ReactFlow coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function layoutTopology(graph: TopologyGraph): Promise<{
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
  groups: TopologyGroupBox[];
}> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [], groups: [] };

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
      // 80 keeps labels (which can overflow the 120px node container by up
      // to ~30px on each side after truncation) from colliding between
      // adjacent siblings in a horizontal row.
      'elk.spacing.nodeNode': '80',
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

  // Compute group bounding boxes — siblings sharing both `parentId` and
  // `agentType` (excluding generic SDK fallbacks) get a translucent box
  // drawn behind them so the user can see the workflow stage at a glance.
  const positionById = new Map(flatChildren.map((c) => [c.id, { x: c.x, y: c.y }]));
  const widthFor = (id: string) =>
    nodeById.get(id)?.node.type === 'skill' ? SKILL_NODE_WIDTH : NODE_WIDTH;
  const heightFor = (id: string) =>
    nodeById.get(id)?.node.type === 'skill' ? SKILL_NODE_HEIGHT : NODE_HEIGHT;

  const clusters = new Map<string, { agentType: string; nodeIds: string[] }>();
  for (const n of graph.nodes) {
    if (n.type === 'skill') continue;
    const agentType = n.agentType;
    if (!agentType || GENERIC_AGENT_TYPES.has(agentType)) continue;
    if (!positionById.has(n.id)) continue;
    const key = `${n.parentId ?? 'root'}::${agentType}`;
    const existing = clusters.get(key);
    if (existing) existing.nodeIds.push(n.id);
    else clusters.set(key, { agentType, nodeIds: [n.id] });
  }

  const groups: TopologyGroupBox[] = [];
  for (const [key, cluster] of clusters) {
    if (cluster.nodeIds.length < GROUP_MIN_SIZE) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of cluster.nodeIds) {
      const pos = positionById.get(id);
      if (!pos) continue;
      const w = widthFor(id);
      const h = heightFor(id);
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + w > maxX) maxX = pos.x + w;
      if (pos.y + h > maxY) maxY = pos.y + h;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) continue;
    groups.push({
      id: `group::${key}`,
      agentType: cluster.agentType,
      nodeCount: cluster.nodeIds.length,
      x: minX - GROUP_BOX_SIDE,
      y: minY - GROUP_BOX_TOP,
      width: maxX - minX + GROUP_BOX_SIDE * 2,
      height: maxY - minY + GROUP_BOX_TOP + GROUP_BOX_BOTTOM,
    });
  }

  return { nodes: rfNodes, edges: rfEdges, groups };
}
