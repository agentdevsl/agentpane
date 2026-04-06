import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { TopologyGraph } from '@/lib/topology/types';
import { getElk } from '@/lib/workflow-dsl/layout';
import type { AgentNodeData } from './nodes/agent-node';
import type { SkillNodeData } from './nodes/skill-node';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 145;
const SKILL_NODE_WIDTH = 160;
const SKILL_NODE_HEIGHT = 50;

export async function layoutTopology(
  graph: TopologyGraph
): Promise<{ nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const elk = await getElk();

  // Build ELK node for a topology node
  function makeElkNode(n: (typeof graph.nodes)[number]): ElkNode {
    const isSkill = n.type === 'skill';
    const w = isSkill ? SKILL_NODE_WIDTH : NODE_WIDTH;
    const h = isSkill ? SKILL_NODE_HEIGHT : NODE_HEIGHT;
    return {
      id: n.id,
      width: w,
      height: h,
      layoutOptions: {
        'org.eclipse.elk.portConstraints': 'FIXED_POS',
      },
      ports: [
        {
          id: `${n.id}__target`,
          layoutOptions: { 'org.eclipse.elk.port.side': 'NORTH' },
          x: w / 2,
          y: 0,
          width: 1,
          height: 1,
        },
        {
          id: `${n.id}__source`,
          layoutOptions: { 'org.eclipse.elk.port.side': 'SOUTH' },
          x: w / 2,
          y: h,
          width: 1,
          height: 1,
        },
      ],
    };
  }

  // Detect groups of concurrent siblings
  const groups = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.group) {
      const list = groups.get(n.group) ?? [];
      list.push(n.id);
      groups.set(n.group, list);
    }
  }
  const groupedNodeIds = new Set<string>();
  for (const ids of groups.values()) {
    for (const id of ids) groupedNodeIds.add(id);
  }

  // Build compound group nodes (laid out horizontally)
  const groupElkNodes: ElkNode[] = [];
  for (const [groupId, nodeIds] of groups) {
    const children = nodeIds
      .map((id) => graph.nodes.find((n) => n.id === id))
      .filter((n): n is (typeof graph.nodes)[number] => n !== undefined)
      .map((n) => makeElkNode(n));
    groupElkNodes.push({
      id: groupId,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '40',
        'elk.padding': '[top=20,left=20,bottom=20,right=20]',
        'elk.contentAlignment': 'H_CENTER V_CENTER',
      },
      children,
    });
  }

  // Top-level children: ungrouped nodes + group compound nodes
  const topChildren = graph.nodes.filter((n) => !groupedNodeIds.has(n.id)).map(makeElkNode);
  topChildren.push(...groupElkNodes);

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '160',
      'elk.layered.spacing.nodeNodeBetweenLayers': '130',
      'elk.edgeRouting': 'SPLINES',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.contentAlignment': 'H_CENTER V_TOP',
      'elk.layered.mergeEdges': 'false',
      'elk.spacing.edgeNode': '80',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '80',
    },
    children: topChildren,
    edges: graph.edges.map((e) => ({
      id: e.id,
      sources: [`${e.sourceId}__source`],
      targets: [`${e.targetId}__target`],
    })),
  };

  const layouted = await elk.layout(elkGraph);

  const nodeById = new Map(graph.nodes.map((n, i) => [n.id, { node: n, index: i }]));

  // Flatten ELK children — compound group nodes contain nested children
  // whose positions are relative to the group. Convert to absolute positions.
  const flatChildren: Array<{ id: string; x: number; y: number }> = [];
  for (const child of layouted.children ?? []) {
    if (groups.has(child.id)) {
      // Compound group — extract nested children with offset
      const groupX = child.x ?? 0;
      const groupY = child.y ?? 0;
      for (const nested of child.children ?? []) {
        flatChildren.push({
          id: nested.id,
          x: groupX + (nested.x ?? 0),
          y: groupY + (nested.y ?? 0),
        });
      }
    } else {
      flatChildren.push({
        id: child.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
      });
    }
  }

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
