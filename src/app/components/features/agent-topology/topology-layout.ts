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
const NODE_WIDTH = 160;
const NODE_HEIGHT = 200;
const SKILL_NODE_WIDTH = 200;
const SKILL_NODE_HEIGHT = 64;

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
const GROUP_BOX_TOP = 44;
const GROUP_BOX_SIDE = 24;
const GROUP_BOX_BOTTOM = 20;
/**
 * Minimum number of sibling nodes that share an agent_type to draw a box.
 * 1 means even singletons get a labelled box, which is visually noisy
 * for one-off Design / Synth nodes; 2+ keeps boxes only for actual fan-
 * outs. Tunable as a hint to the user what the workflow stage is.
 */
const GROUP_MIN_SIZE = 1;

/**
 * Maximum horizontal gap between consecutive same-cluster members
 * before they're split into separate sub-clusters. Two same-type
 * agents that were spawned in different phases (and thus separated
 * by other siblings in mrtree's order) need to render as two boxes,
 * not one giant box stretching across the canvas. The threshold is
 * `NODE_WIDTH + nodeNode spacing` ≈ one unrelated-sibling slot —
 * anything wider than that means at least one foreign node sits
 * between the two members and the cluster is discontinuous.
 */
const MAX_INTRA_CLUSTER_GAP_X = NODE_WIDTH;

/**
 * When a sibling cluster has this many or more leaf members we wrap it
 * onto two rows instead of letting mrtree spread them across one wide
 * row. 2 yields a vertical stack, 3 yields 2+1 (bottom centred),
 * 4 yields 2x2, 6 yields 3+3, etc. Only applied to "leaf" clusters (no
 * agent descendants) so the second row can't collide with a layer below.
 */
const WRAP_THRESHOLD = 2;
/** Vertical gap between the two rows in a wrapped cluster. */
const WRAP_ROW_GAP_Y = 28;
/** Horizontal step between consecutive members within a wrapped row — matches the tightened `elk.spacing.nodeNode` plus the node width. */
const WRAP_STEP_X = NODE_WIDTH + 32;

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
      // Tightened to 32 so adjacent clusters/members sit close enough
      // that fitView can zoom up to a readable size on a wide canvas.
      // Names now wrap to 3 lines within the node's 160px width so we
      // don't need to leave room for label overflow between siblings.
      'elk.spacing.nodeNode': '32',
      'elk.spacing.edgeNode': '12',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
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

  // mrtree's vertical layer separation leaves a large gap between the
  // root agent and its children. The row of children is the workflow
  // signal; the empty band above it is just whitespace. Pull each root
  // down so the gap to its nearest direct child is a tighter fixed
  // value, shrinking the bbox vertically while preserving the row
  // ordering and intra-cluster geometry.
  const ROOT_TO_CHILD_GAP_Y = 56;
  const directChildIdsByParent = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = directChildIdsByParent.get(e.sourceId) ?? [];
    list.push(e.targetId);
    directChildIdsByParent.set(e.sourceId, list);
  }
  const rootIds = graph.nodes.filter((n) => (incomingCount.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const rootId of rootIds) {
    const rootChild = flatChildren.find((c) => c.id === rootId);
    if (!rootChild) continue;
    const childIds = directChildIdsByParent.get(rootId) ?? [];
    if (childIds.length === 0) continue;
    let childMinY = Number.POSITIVE_INFINITY;
    for (const cid of childIds) {
      const cy = flatChildren.find((c) => c.id === cid)?.y;
      if (cy !== undefined && cy < childMinY) childMinY = cy;
    }
    if (!Number.isFinite(childMinY)) continue;
    const targetRootY = childMinY - ROOT_TO_CHILD_GAP_Y - NODE_HEIGHT;
    if (targetRootY > rootChild.y) rootChild.y = targetRootY;
  }

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

  // Wrap multi-member leaf clusters onto two rows so they don't stretch
  // the canvas horizontally and so every cluster reads as a 2-row block
  // for visual consistency. Only applied to "leaf" clusters (no agent
  // descendants) — pushing a member down would otherwise overlap the
  // layer that mrtree placed below it. `wrapEdgeReroute` re-sources the
  // bottom-row's parent edge to the matching top-row sibling so the
  // visual chain reads parent → top → bottom instead of an edge cutting
  // straight through the top-row node.
  const hasAgentChild = new Set<string>();
  for (const e of graph.edges) {
    const target = nodeById.get(e.targetId)?.node;
    if (!target || target.type === 'skill') continue;
    hasAgentChild.add(e.sourceId);
  }
  // Wrap each leaf cluster into a 2-row block. Bottom-row members are
  // pinned directly under their top-row partner so the cluster reads
  // as a left-to-right, top-to-bottom grid (which preserves spawn
  // order regardless of whether the agents ran concurrently or
  // sequentially — the position alone tells the reader). Each
  // bottom-row node's parent edge is re-sourced through the top-row
  // node above it so no edge has to cut through another node's body
  // to reach the lower row. The reroute is purely visual; the
  // underlying topology data still has the original parent.
  const wrapEdgeReroute = new Map<string, string>();
  for (const cluster of splitClusters.values()) {
    if (cluster.ids.some((id) => hasAgentChild.has(id))) continue;
    if (cluster.ids.length < WRAP_THRESHOLD) continue;
    const sorted = [...cluster.ids].sort((a, b) => {
      const ax = positionById.get(a)?.x ?? 0;
      const bx = positionById.get(b)?.x ?? 0;
      return ax - bx;
    });
    const firstId = sorted[0];
    const firstPos = firstId ? positionById.get(firstId) : undefined;
    if (!firstPos) continue;
    const n = sorted.length;
    const topCount = Math.ceil(n / 2);
    const bottomCount = n - topCount;
    const leftX = firstPos.x;
    const topY = firstPos.y;
    const bottomY = topY + NODE_HEIGHT + WRAP_ROW_GAP_Y;
    for (let i = 0; i < topCount; i++) {
      const id = sorted[i];
      const pos = id ? positionById.get(id) : undefined;
      if (!pos) continue;
      pos.x = leftX + i * WRAP_STEP_X;
      pos.y = topY;
    }
    for (let i = 0; i < bottomCount; i++) {
      const botId = sorted[topCount + i];
      const topId = sorted[i];
      if (!botId || !topId) continue;
      const botPos = positionById.get(botId);
      if (!botPos) continue;
      botPos.x = leftX + i * WRAP_STEP_X;
      botPos.y = bottomY;
      wrapEdgeReroute.set(botId, topId);
    }
  }

  // Build per-cluster left/right extents grouped by the row they sit in.
  // mrtree puts all siblings on one Y, but we tolerate small drift by
  // bucketing on rounded y to handle sub-row jitter from mrtree's
  // `verticalAlignment` heuristics.
  const MIN_INTER_CLUSTER_GAP_X = 16;
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

  // Sweep clusters left-to-right per row and pin every consecutive pair
  // to the same channel width. Unlike a min-only enforcement, this both
  // expands gaps that are too small AND compacts gaps that are too wide
  // — mrtree spaces clusters based on the original wide single-row
  // layout, so once the wrap pass narrows them the original gaps leave
  // dead horizontal space between cluster outlines. The leftmost cluster
  // in each row anchors the row's origin (we never shift it).
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
      const targetLeftPadded = prevRightPadded + MIN_INTER_CLUSTER_GAP_X;
      const shift = targetLeftPadded - curLeftPadded;
      if (shift === 0) continue;
      for (const id of cur.members) {
        const pos = positionById.get(id);
        if (pos) pos.x += shift;
      }
      cur.left += shift;
      cur.right += shift;
    }
  }

  // Re-centre each root horizontally above the centre of its direct
  // children's rendered span. mrtree centres a parent over its
  // *subtree* centroid, which is biased by descendant counts and pulls
  // the root off-axis when one branch fans out wider than another. The
  // user's mental model is "root sits above the row" — that's only
  // true if the root x is the midpoint of the visible row. Pure x
  // shift on roots; doesn't move any descendants.
  for (const rootId of rootIds) {
    const rootChild = flatChildren.find((c) => c.id === rootId);
    if (!rootChild) continue;
    const childIds = directChildIdsByParent.get(rootId) ?? [];
    if (childIds.length === 0) continue;
    let childMinX = Number.POSITIVE_INFINITY;
    let childMaxX = Number.NEGATIVE_INFINITY;
    for (const cid of childIds) {
      const childPos = positionById.get(cid);
      if (!childPos) continue;
      const isSkill = nodeById.get(cid)?.node.type === 'skill';
      const w = isSkill ? SKILL_NODE_WIDTH : NODE_WIDTH;
      if (childPos.x < childMinX) childMinX = childPos.x;
      if (childPos.x + w > childMaxX) childMaxX = childPos.x + w;
    }
    if (!Number.isFinite(childMinX)) continue;
    const centroidX = (childMinX + childMaxX) / 2;
    rootChild.x = centroidX - NODE_WIDTH / 2;
  }

  // Re-pin skill nodes directly above their parent agent. mrtree puts
  // the skill in the same row as agent clusters (which then drifts off
  // to the far right after cluster-shift), and the previous "right of
  // parent" placement caused skills to overlap neighbouring clusters
  // when the inter-cluster gap was tight. Centring the skill above the
  // parent keeps the (skill → agent) flow visually obvious and the
  // ~20px overflow per side fits inside the inter-cluster gap.
  const SKILL_VERTICAL_GAP = 16; // gap between skill bottom and parent top
  for (const n of graph.nodes) {
    if (n.type !== 'skill') continue;
    const skillPos = positionById.get(n.id);
    if (!skillPos) continue;
    const parentId = n.parentId;
    if (!parentId) continue;
    const parentPos = positionById.get(parentId);
    if (!parentPos) continue;
    const parentNode = nodeById.get(parentId)?.node;
    const parentWidth = parentNode?.type === 'skill' ? SKILL_NODE_WIDTH : NODE_WIDTH;
    skillPos.x = parentPos.x + (parentWidth - SKILL_NODE_WIDTH) / 2;
    skillPos.y = parentPos.y - SKILL_NODE_HEIGHT - SKILL_VERTICAL_GAP;
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
    // For wrapped-cluster bottom-row nodes, re-source the parent edge
    // to the top-row sibling directly above so the line reads as a
    // chain (parent → top → bottom) instead of cutting through the top
    // node. The underlying topology data still has the parent as the
    // logical parent — this is purely a rendering routing.
    const reroutedSource = wrapEdgeReroute.get(e.targetId);
    const effectiveSourceId = reroutedSource ?? e.sourceId;
    const sourceEntry = nodeById.get(effectiveSourceId);
    return {
      id: e.id,
      source: effectiveSourceId,
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

  // Leaf clusters always render as a 2-row block for visual
  // consistency, even when the cluster only has 1 member or didn't hit
  // the wrap threshold. The fixed height keeps the row of cluster
  // outlines aligned across the canvas instead of having tall wrapped
  // boxes next to short single-row ones. Non-leaf clusters keep their
  // computed bbox so the box doesn't extend down into the layer below.
  const TWO_ROW_CONTENT_HEIGHT = NODE_HEIGHT * 2 + WRAP_ROW_GAP_Y;
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
    const isLeaf = cluster.ids.every((id) => !hasAgentChild.has(id));
    const contentHeight = isLeaf ? TWO_ROW_CONTENT_HEIGHT : maxY - minY;
    groups.push({
      id: `group::${key}`,
      agentType: cluster.agentType,
      nodeCount: cluster.ids.length,
      x: minX - GROUP_BOX_SIDE,
      y: minY - GROUP_BOX_TOP,
      width: maxX - minX + GROUP_BOX_SIDE * 2,
      height: contentHeight + GROUP_BOX_TOP + GROUP_BOX_BOTTOM,
    });
  }

  // No box-edge resolution needed here — the earlier cluster-shift pass
  // already pushed clusters apart at the node level, so each cluster's
  // padded bbox naturally has a clean horizontal channel to its
  // neighbour. Boxes are computed from the post-shift positions.

  return { nodes: rfNodes, edges: rfEdges, groups };
}
