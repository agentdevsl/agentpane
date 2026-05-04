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
 * The AgentNode SVG renders with `overflow: visible`, so the name and
 * metric labels (centred on a 120px container, font-size 12) can extend
 * beyond the container width when text is long. With `MAX_NAME_CHARS = 22`
 * in `agent-node.tsx`, a fully-truncated name at 12px renders ~190px wide
 * — about 35px of overflow on each side of the 120px container. Side
 * padding has to cover that overflow plus a little breathing room,
 * otherwise the leftmost / rightmost cluster member shows label text
 * outside the dashed cluster outline.
 *
 * Vertical padding leaves room for:
 *   - top: the type label (~14px line height + a 6px gap)
 *   - bottom: the metrics line (in running mode it sits at container
 *     y≈132 with ~12px text height, just inside the 145px container, but
 *     a little extra keeps it visually inside the box rather than flush
 *     against the border)
 */
const GROUP_BOX_TOP = 26;
const GROUP_BOX_SIDE = 44;
const GROUP_BOX_BOTTOM = 28;
/**
 * Minimum number of sibling nodes that share an agent_type to draw a box.
 * 1 means even singletons get a labelled box, which is visually noisy
 * for one-off Design / Synth nodes; 2+ keeps boxes only for actual fan-
 * outs. Tunable as a hint to the user what the workflow stage is.
 */
const GROUP_MIN_SIZE = 1;

/**
 * Maximum horizontal gap between consecutive same-cluster members
 * before they're split into separate sub-clusters. Without this, two
 * agents that share a (parentId, agentType) but were spawned in
 * different phases — and thus end up far apart in mrtree's order — get
 * drawn as a single cluster box that stretches across the canvas with
 * empty space in the middle. NODE_WIDTH * 2 is roughly "one full slot
 * for an unrelated sibling between them" — anything wider than that
 * means the cluster has discontinuous visual presence and should
 * render as two boxes instead of one.
 */
const MAX_INTRA_CLUSTER_GAP_X = NODE_WIDTH * 2;

/**
 * Group nodes by `(parentId, agentType)`, then split each group into
 * sub-clusters of visually-adjacent members. Returns a Map keyed by a
 * synthetic id that includes a split index when a base cluster was
 * broken apart, so downstream box-rendering / cluster-shifting code can
 * treat each sub-cluster independently.
 */
function buildClusterMembers(
  graph: TopologyGraph,
  positionById: Map<string, { id: string; x: number; y: number }>,
  isClusterEligible: (n: TopologyGraph['nodes'][number]) => boolean
): Map<string, { agentType: string; parentKey: string; ids: string[] }> {
  // Step 1 — bucket by base key.
  const baseBuckets = new Map<string, { agentType: string; parentKey: string; ids: string[] }>();
  for (const n of graph.nodes) {
    if (!isClusterEligible(n)) continue;
    if (!positionById.has(n.id)) continue;
    if (!n.agentType) continue;
    const parentKey = n.parentId ?? 'root';
    const key = `${parentKey}::${n.agentType}`;
    const bucket = baseBuckets.get(key);
    if (bucket) bucket.ids.push(n.id);
    else baseBuckets.set(key, { agentType: n.agentType, parentKey, ids: [n.id] });
  }

  // Step 2 — within each bucket, split members whose mrtree-x positions
  // are too far apart. Sort by x, walk, start a new sub-cluster
  // whenever gap-to-next exceeds the threshold.
  const result = new Map<string, { agentType: string; parentKey: string; ids: string[] }>();
  for (const [baseKey, bucket] of baseBuckets) {
    const sorted = [...bucket.ids].sort((a, b) => {
      const ax = positionById.get(a)?.x ?? 0;
      const bx = positionById.get(b)?.x ?? 0;
      return ax - bx;
    });
    let split: string[] = [];
    let splitIndex = 0;
    let prevRight = Number.NEGATIVE_INFINITY;
    const flush = () => {
      if (split.length === 0) return;
      const splitKey = splitIndex === 0 ? baseKey : `${baseKey}#${splitIndex}`;
      result.set(splitKey, {
        agentType: bucket.agentType,
        parentKey: bucket.parentKey,
        ids: split,
      });
      splitIndex++;
      split = [];
    };
    for (const id of sorted) {
      const pos = positionById.get(id);
      if (!pos) continue;
      // Use the right edge of the previous member as the gap baseline so
      // wide-but-touching members aren't accidentally split.
      if (split.length > 0 && pos.x - prevRight > MAX_INTRA_CLUSTER_GAP_X) {
        flush();
      }
      split.push(id);
      prevRight = pos.x + NODE_WIDTH;
    }
    flush();
  }
  return result;
}

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

  // Compute per-cluster horizontal extents (per `parentId + agentType`)
  // and shift entire clusters apart so their padded boxes don't overlap.
  // Different from the per-pair box-edge resolution further down: this
  // shifts the underlying nodes too, so the visible nodes inside each
  // cluster maintain mrtree's relative layout while different clusters
  // get spread out enough that the surrounding boxes never touch.
  const NON_GROUPABLE = new Set([...GENERIC_AGENT_TYPES]);
  const positionById = new Map(flatChildren.map((c) => [c.id, c]));
  const isClusterEligible = (n: (typeof graph.nodes)[number]): boolean =>
    n.type !== 'skill' && !!n.agentType && !NON_GROUPABLE.has(n.agentType);

  // Build cluster groups, splitting any base cluster (parentId+agentType)
  // whose members ended up far apart in mrtree's layout. This is the
  // single source of truth used by both the cluster-shift extents below
  // and the final TopologyGroupBox computation further down — without
  // this, planning-phase and execution-phase agents that happened to
  // share a (parent, agentType) get drawn as one giant cluster box
  // stretched across the canvas with empty space in the middle.
  const splitClusters = buildClusterMembers(graph, positionById, isClusterEligible);

  // Build per-cluster left/right extents grouped by the row they sit in.
  // mrtree puts all siblings on one Y, but we tolerate small drift by
  // bucketing on rounded y to handle sub-row jitter from mrtree's
  // `verticalAlignment` heuristics.
  const MIN_INTER_CLUSTER_GAP_X = 36;
  const ROW_KEY_TOLERANCE = 30;
  type ClusterExtent = {
    key: string;
    rowKey: number;
    members: string[];
    left: number;
    right: number;
  };
  const extents: ClusterExtent[] = [];
  for (const [key, cluster] of splitClusters) {
    if (cluster.ids.length === 0) continue;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    for (const id of cluster.ids) {
      const pos = positionById.get(id);
      if (!pos) continue;
      const w = nodeById.get(id)?.node.type === 'skill' ? SKILL_NODE_WIDTH : NODE_WIDTH;
      if (pos.x < left) left = pos.x;
      if (pos.x + w > right) right = pos.x + w;
      if (pos.y < yMin) yMin = pos.y;
    }
    if (!Number.isFinite(left)) continue;
    extents.push({
      key,
      rowKey: Math.round(yMin / ROW_KEY_TOLERANCE) * ROW_KEY_TOLERANCE,
      members: cluster.ids,
      left,
      right,
    });
  }

  // Sweep clusters left-to-right per row and push subsequent clusters
  // far enough right that their padded boxes leave a clean
  // MIN_INTER_CLUSTER_GAP_X channel between cluster outlines.
  const extentsByRow = new Map<number, ClusterExtent[]>();
  for (const e of extents) {
    const list = extentsByRow.get(e.rowKey) ?? [];
    list.push(e);
    extentsByRow.set(e.rowKey, list);
  }
  for (const rowExtents of extentsByRow.values()) {
    rowExtents.sort((a, b) => a.left - b.left);
    for (let i = 1; i < rowExtents.length; i++) {
      const prev = rowExtents[i - 1];
      const cur = rowExtents[i];
      if (!prev || !cur) continue;
      // Padded right edge of prev cluster + padded left edge of cur cluster.
      const prevRightPadded = prev.right + GROUP_BOX_SIDE;
      const curLeftPadded = cur.left - GROUP_BOX_SIDE;
      if (curLeftPadded - prevRightPadded >= MIN_INTER_CLUSTER_GAP_X) continue;
      const shift = prevRightPadded + MIN_INTER_CLUSTER_GAP_X - curLeftPadded;
      // Move every member of `cur` (and update its extent record so the
      // next iteration sees the new position).
      for (const id of cur.members) {
        const pos = positionById.get(id);
        if (pos) pos.x += shift;
      }
      cur.left += shift;
      cur.right += shift;
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

  // Compute group bounding boxes — siblings sharing both `parentId` and
  // `agentType` (excluding generic SDK fallbacks) get a translucent box
  // drawn behind them so the user can see the workflow stage at a glance.
  // (Positions are read from the same `positionById` map populated above
  // — the cluster-shift pass updates it in place.)
  const widthFor = (id: string) =>
    nodeById.get(id)?.node.type === 'skill' ? SKILL_NODE_WIDTH : NODE_WIDTH;
  const heightFor = (id: string) =>
    nodeById.get(id)?.node.type === 'skill' ? SKILL_NODE_HEIGHT : NODE_HEIGHT;

  // Re-compute clusters using the same split-aware bucketing the cluster-
  // shift pass used. Member positions have been updated in place by the
  // shift, so reading positionById here picks up the post-shift x.
  const clustersForGroups = buildClusterMembers(graph, positionById, isClusterEligible);

  const groups: TopologyGroupBox[] = [];
  for (const [key, cluster] of clustersForGroups) {
    if (cluster.ids.length < GROUP_MIN_SIZE) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of cluster.ids) {
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
      nodeCount: cluster.ids.length,
      x: minX - GROUP_BOX_SIDE,
      y: minY - GROUP_BOX_TOP,
      width: maxX - minX + GROUP_BOX_SIDE * 2,
      height: maxY - minY + GROUP_BOX_TOP + GROUP_BOX_BOTTOM,
    });
  }

  // No box-edge resolution needed here — the earlier cluster-shift pass
  // already pushed clusters apart at the node level, so each cluster's
  // padded bbox naturally has a clean horizontal channel to its
  // neighbour. Boxes are computed from the post-shift positions.

  return { nodes: rfNodes, edges: rfEdges, groups };
}
