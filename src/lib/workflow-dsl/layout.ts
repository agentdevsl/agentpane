/**
 * Workflow Layout Utility
 *
 * Uses ELK (Eclipse Layout Kernel) to automatically calculate positions for
 * workflow nodes based on their edge connections, producing clean hierarchical layouts.
 *
 * Supported algorithms:
 * - Layered: Hierarchical layouts with configurable direction
 * - Force: Force-directed layouts
 * - Box: Grid-based box layouts
 * - Random: Random placement
 */

import { createId } from '@paralleldrive/cuid2';
import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from '@xyflow/react';
import type { LayoutOptions as ElkLayoutOptions, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Position, WorkflowEdge, WorkflowNode } from './types.js';

// Lazy-initialize ELK instance to avoid server-side worker issues
let elkInstance: typeof import('elkjs/lib/elk.bundled.js').default.prototype | null = null;

export async function getElk(): Promise<
  typeof import('elkjs/lib/elk.bundled.js').default.prototype
> {
  if (!elkInstance) {
    const ELKModule = await import('elkjs/lib/elk.bundled.js');
    elkInstance = new ELKModule.default();
  }
  return elkInstance;
}

// =============================================================================
// LAYOUT OPTIONS
// =============================================================================

export interface LayoutOptions {
  /** Layout algorithm: layered (hierarchical), force, box, random */
  algorithm?: 'layered' | 'force' | 'box' | 'random';
  /** Graph direction: DOWN, UP, LEFT, RIGHT */
  direction?: 'DOWN' | 'UP' | 'LEFT' | 'RIGHT';
  /** Width of each node in pixels */
  nodeWidth?: number;
  /** Height of each node in pixels */
  nodeHeight?: number;
  /** Spacing between nodes */
  nodeSpacing?: number;
  /** Spacing between layers/ranks */
  layerSpacing?: number;
  /** Edge routing: ORTHOGONAL, POLYLINE, SPLINES */
  edgeRouting?: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES';
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  algorithm: 'layered',
  direction: 'DOWN',
  nodeWidth: 280, // Base width for ELK positioning (matches CSS fallback)
  nodeHeight: 32, // Compact node height
  nodeSpacing: 30, // Horizontal spacing between parallel nodes
  layerSpacing: 45, // Vertical gap between layers
  edgeRouting: 'ORTHOGONAL',
};

// =============================================================================
// DYNAMIC NODE WIDTH CALCULATION
// =============================================================================

/** Approximate character widths for width estimation */
const CHAR_WIDTH = {
  label: 7, // ~11px font, semi-bold
  mono: 6.5, // ~10px mono font
};

/** Fixed width components */
const NODE_PADDING = {
  icon: 18, // Icon width
  badge: 40, // Type badge width
  padding: 24, // Left/right padding + gaps
  separator: 10, // Dot separator + gaps
};

const MIN_NODE_WIDTH = 150;
const MAX_NODE_WIDTH = 450;
const MAX_SECONDARY_CHARS = 25; // Cap secondary text for width calculation

/**
 * Estimates the width needed for a single node based on its content.
 */
function estimateNodeWidth(node: WorkflowNode): number {
  const label = node.label || '';

  // Get secondary text (skillId, content, etc.)
  let secondaryText = '';
  if (node.type === 'skill' && 'skillId' in node) {
    secondaryText = (node.skillId as string) || '';
  } else if (node.type === 'context' && 'content' in node) {
    secondaryText = (node.content as string) || '';
  }

  // Calculate text widths (cap secondary text to avoid overly wide nodes)
  const labelWidth = label.length * CHAR_WIDTH.label;
  const cappedSecondaryLength = Math.min(secondaryText.length, MAX_SECONDARY_CHARS);
  const secondaryWidth = secondaryText ? cappedSecondaryLength * CHAR_WIDTH.mono : 0;

  // Total width = icon + label + separator (if secondary) + secondary + badge + padding
  const hasSecondary = secondaryText.length > 0;
  const contentWidth = labelWidth + (hasSecondary ? NODE_PADDING.separator + secondaryWidth : 0);
  const totalWidth = NODE_PADDING.icon + contentWidth + NODE_PADDING.badge + NODE_PADDING.padding;

  return Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, totalWidth));
}

/**
 * Calculates the uniform width needed to fit all nodes.
 * Returns the maximum width across all nodes, clamped to min/max bounds.
 */
export function calculateUniformNodeWidth(nodes: WorkflowNode[]): number {
  if (nodes.length === 0) return MIN_NODE_WIDTH;

  const maxWidth = nodes.reduce((max, node) => {
    const width = estimateNodeWidth(node);
    return Math.max(max, width);
  }, MIN_NODE_WIDTH);

  // Round up to nearest 10px for cleaner values
  return Math.ceil(maxWidth / 10) * 10;
}

// =============================================================================
// ELK LAYOUT
// =============================================================================

/**
 * Converts our layout options to ELK layout options.
 */
function toElkLayoutOptions(opts: Required<LayoutOptions>): ElkLayoutOptions {
  return {
    'elk.algorithm': opts.algorithm,
    'elk.direction': opts.direction,
    // Node spacing
    'elk.spacing.nodeNode': String(opts.nodeSpacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.layerSpacing),
    // Edge routing
    'elk.edgeRouting': opts.edgeRouting,
    // Crossing minimization
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    // Node placement - LINEAR_SEGMENTS for better vertical alignment
    'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
    // Spacing
    'elk.layered.spacing.edgeNodeBetweenLayers': String(opts.layerSpacing),
    'elk.layered.spacing.edgeEdgeBetweenLayers': String(opts.layerSpacing / 2),
    // Preserve model order - important for sequential workflows
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    // Merge edges for cleaner look
    'elk.layered.mergeEdges': 'true',
    // Center the graph
    'elk.contentAlignment': 'H_CENTER V_TOP',
  };
}

/**
 * Uses ELK to calculate optimal node positions.
 * Always uses ELK for consistent professional layouts with auto-centering.
 */
async function elkLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  opts: Required<LayoutOptions>
): Promise<Map<string, Position>> {
  const positions = new Map<string, Position>();

  if (nodes.length === 0) {
    return positions;
  }

  // Always use ELK for layout
  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: toElkLayoutOptions(opts),
    children: nodes.map((node) => ({
      id: node.id,
      width: opts.nodeWidth,
      height: opts.nodeHeight,
    })),
    edges: edges
      .filter((edge) => {
        // Only include edges where both source and target exist
        const nodeIds = new Set(nodes.map((n) => n.id));
        return nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId);
      })
      .map((edge) => ({
        id: edge.id,
        sources: [edge.sourceNodeId],
        targets: [edge.targetNodeId],
      })),
  };

  try {
    const elk = await getElk();
    const layoutedGraph = await elk.layout(elkGraph);

    // Extract positions from layouted graph
    for (const child of layoutedGraph.children ?? []) {
      if (child.x !== undefined && child.y !== undefined) {
        positions.set(child.id, { x: child.x, y: child.y });
      }
    }

    // Post-process: normalize positions to start at x=0
    normalizePositions(positions);
  } catch (_error) {
    // Fall back to simple positioning
    nodes.forEach((node, index) => {
      positions.set(node.id, {
        x: 0,
        y: index * (opts.nodeHeight + opts.layerSpacing),
      });
    });
  }

  return positions;
}

/**
 * Normalizes node positions to start at x=0.
 * With uniform node widths (enforced by CSS min-width), alignment is handled automatically.
 */
function normalizePositions(positions: Map<string, Position>): void {
  if (positions.size === 0) return;

  // Find min x to shift all nodes to start at x=0
  let minX = Infinity;
  for (const pos of positions.values()) {
    minX = Math.min(minX, pos.x);
  }

  // Shift all nodes so minimum x is 0
  for (const [id, pos] of positions) {
    positions.set(id, { x: pos.x - minX, y: pos.y });
  }
}

// =============================================================================
// EDGE CONNECTIVITY
// =============================================================================

/**
 * Finds the topological head and tail of the middle-node chain using
 * BFS reachability cardinality through the middle-edge subgraph.
 *
 * For each head candidate (no incoming middle edges), BFS forward and count
 * reachable nodes. The candidate that reaches the most nodes is the real head;
 * the first reachable node (in array order) with no outgoing middle edges is
 * the real tail.
 *
 * This correctly handles isolated nodes and dead-end forks — they have short
 * reachable sets and lose to the main chain's head candidate.
 *
 * Falls back to array order if topology is ambiguous.
 */
export function findChainHeadAndTail(
  middleNodes: WorkflowNode[],
  edges: WorkflowEdge[]
): { head: WorkflowNode; tail: WorkflowNode } {
  if (middleNodes.length === 1) {
    const only = middleNodes[0] as WorkflowNode;
    return { head: only, tail: only };
  }

  const middleIds = new Set(middleNodes.map((n) => n.id));

  // Edges between middle nodes only
  const middleEdges = edges.filter(
    (e) => middleIds.has(e.sourceNodeId) && middleIds.has(e.targetNodeId)
  );

  const hasIncoming = new Set(middleEdges.map((e) => e.targetNodeId));
  const hasOutgoing = new Set(middleEdges.map((e) => e.sourceNodeId));

  // Build outgoing adjacency
  const successors = new Map<string, Set<string>>();
  for (const e of middleEdges) {
    if (!successors.has(e.sourceNodeId)) successors.set(e.sourceNodeId, new Set());
    successors.get(e.sourceNodeId)?.add(e.targetNodeId);
  }

  // Head candidates: no incoming from other middle nodes
  const headCandidates = middleNodes.filter((n) => !hasIncoming.has(n.id));

  let bestHead: WorkflowNode = (headCandidates[0] ?? middleNodes[0]) as WorkflowNode;
  let bestTail: WorkflowNode = middleNodes[middleNodes.length - 1] as WorkflowNode;
  let bestReachable = 0;

  for (const candidate of headCandidates) {
    // BFS from candidate to find all reachable middle nodes
    const reachable = new Set<string>([candidate.id]);
    const queue = [candidate.id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      for (const next of successors.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }

    if (reachable.size > bestReachable) {
      bestReachable = reachable.size;
      bestHead = candidate;
      // Tail = reachable node with no outgoing middle edges (end of the chain)
      const tailInChain = middleNodes.find(
        (n) => reachable.has(n.id) && !hasOutgoing.has(n.id) && n.id !== candidate.id
      );
      bestTail = tailInChain ?? candidate;
    }
  }

  return { head: bestHead, tail: bestTail };
}

/**
 * Ensures start and end nodes are properly connected to the workflow chain.
 * Uses edge topology to find the actual first/last nodes in the chain,
 * rather than relying on array order (which may not match workflow order).
 * Returns a new edges array (does not mutate input).
 */
export function ensureStartEndConnected(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const startNode = nodes.find((n) => n.type === 'start');
  const endNode = nodes.find((n) => n.type === 'end');
  const middleNodes = nodes.filter((n) => n.type !== 'start' && n.type !== 'end');

  if (middleNodes.length === 0) return edges;

  let result = [...edges];
  const { head: firstNode, tail: lastNode } = findChainHeadAndTail(middleNodes, edges);

  // Fix start → first middle node
  if (startNode) {
    const hasCorrectStartEdge = result.some(
      (e) => e.sourceNodeId === startNode.id && e.targetNodeId === firstNode.id
    );
    if (!hasCorrectStartEdge) {
      result = result.filter((e) => e.sourceNodeId !== startNode.id);
      result.unshift({
        id: `auto-start-${createId().slice(0, 8)}`,
        type: 'sequential',
        sourceNodeId: startNode.id,
        targetNodeId: firstNode.id,
      });
    }
  }

  // Fix last middle node → end
  if (endNode) {
    const hasCorrectEndEdge = result.some(
      (e) => e.sourceNodeId === lastNode.id && e.targetNodeId === endNode.id
    );
    if (!hasCorrectEndEdge) {
      result = result.filter((e) => e.targetNodeId !== endNode.id);
      result.push({
        id: `auto-end-${createId().slice(0, 8)}`,
        type: 'sequential',
        sourceNodeId: lastNode.id,
        targetNodeId: endNode.id,
      });
    }
  }

  return result;
}

// =============================================================================
// MAIN LAYOUT FUNCTION
// =============================================================================

/**
 * Calculates automatic layout positions for workflow nodes.
 * Uses ELK (Eclipse Layout Kernel) for professional-quality hierarchical layouts.
 *
 * @param nodes - Array of workflow nodes to layout
 * @param edges - Array of workflow edges defining connections
 * @param options - Optional layout configuration
 * @returns Promise resolving to new array of nodes with updated positions
 *
 * @example
 * ```ts
 * const layoutedNodes = await layoutWorkflow(workflow.nodes, workflow.edges, {
 *   direction: 'RIGHT',
 *   algorithm: 'layered',
 * });
 * ```
 */
export async function layoutWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options?: LayoutOptions
): Promise<WorkflowNode[]> {
  if (nodes.length === 0) {
    return [];
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Use ELK for professional layout
  const positions = await elkLayout(nodes, edges, opts);

  return nodes.map((node) => {
    const newPosition = positions.get(node.id);
    if (!newPosition) {
    }
    return {
      ...node,
      position: newPosition ?? node.position,
    };
  });
}

// =============================================================================
// REACTFLOW CONVERSION HELPERS
// =============================================================================

/**
 * Maps standard node types to compact node types for the v3 pill design.
 * Note: A similar function exists in src/app/components/features/workflow-designer/index.tsx.
 */
function mapToCompactNodeType(type: WorkflowNode['type']): string {
  switch (type) {
    case 'start':
      return 'compactStart';
    case 'end':
      return 'compactEnd';
    case 'context':
      return 'compactContext';
    case 'skill':
      return 'compactSkill';
    case 'agent':
      return 'compactAgent';
    case 'conditional':
    case 'loop':
    case 'parallel':
      return type;
    default:
      return type as string;
  }
}

export interface ToReactFlowNodesOptions {
  /** Use compact node types (v3 design) - default: true */
  useCompactNodes?: boolean;
  /** Uniform width for all nodes (calculated dynamically if not provided) */
  uniformWidth?: number;
}

/**
 * Converts WorkflowNode array to ReactFlow Node array.
 *
 * @param nodes - Array of workflow nodes
 * @param options - Conversion options
 * @returns Array of ReactFlow-compatible nodes
 */
export function toReactFlowNodes(
  nodes: WorkflowNode[],
  options: ToReactFlowNodesOptions = {}
): ReactFlowNode[] {
  const { useCompactNodes = true, uniformWidth } = options;

  // Calculate uniform width if not provided
  const nodeWidth = uniformWidth ?? calculateUniformNodeWidth(nodes);

  return nodes.map((node, index) => ({
    id: node.id,
    type: useCompactNodes ? mapToCompactNodeType(node.type) : node.type,
    position: node.position,
    data: {
      label: node.label,
      description: node.description,
      metadata: node.metadata,
      // Node index for staggered animation
      nodeIndex: index,
      // Original node type for reference
      nodeType: node.type,
      // Uniform width for CSS styling
      uniformWidth: nodeWidth,
      // Spread node-specific properties
      ...extractNodeSpecificData(node),
    },
  }));
}

/**
 * Converts WorkflowEdge array to ReactFlow Edge array.
 *
 * @param edges - Array of workflow edges
 * @returns Array of ReactFlow-compatible edges
 */
export function toReactFlowEdges(edges: WorkflowEdge[]): ReactFlowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: mapEdgeType(edge.type),
    label: edge.label,
    data: {
      edgeType: edge.type,
      metadata: edge.metadata,
      // Spread edge-specific properties
      ...extractEdgeSpecificData(edge),
    },
  }));
}

/**
 * Converts ReactFlow nodes back to WorkflowNode array.
 * Note: This requires the original node data to preserve type-specific properties.
 *
 * @param reactFlowNodes - Array of ReactFlow nodes
 * @param originalNodes - Original workflow nodes for reference
 * @returns Array of workflow nodes with updated positions
 */
export function fromReactFlowNodes(
  reactFlowNodes: ReactFlowNode[],
  originalNodes: WorkflowNode[]
): WorkflowNode[] {
  const originalNodeMap = new Map(originalNodes.map((n) => [n.id, n]));

  return reactFlowNodes.map((rfNode) => {
    const original = originalNodeMap.get(rfNode.id);
    if (!original) {
      throw new Error(`Original node not found for id: ${rfNode.id}`);
    }

    return {
      ...original,
      position: {
        x: rfNode.position.x,
        y: rfNode.position.y,
      },
    };
  });
}

export interface LayoutWorkflowForReactFlowOptions extends LayoutOptions {
  /** Use compact node types (v3 design) - default: true */
  useCompactNodes?: boolean;
  /** Skip ensureStartEndConnected — use when edges are already server-validated */
  skipConnectivityFix?: boolean;
}

/**
 * Applies layout to workflow and returns ReactFlow-compatible nodes and edges.
 * Calculates dynamic uniform node width based on content for consistent visual styling.
 *
 * @param nodes - Array of workflow nodes
 * @param edges - Array of workflow edges
 * @param options - Optional layout and conversion configuration
 * @returns Promise resolving to object containing ReactFlow nodes and edges
 */
export async function layoutWorkflowForReactFlow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options?: LayoutWorkflowForReactFlowOptions
): Promise<{ nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }> {
  const { useCompactNodes = true, skipConnectivityFix = false, ...layoutOptions } = options ?? {};

  const uniformWidth = calculateUniformNodeWidth(nodes);

  // Skip connectivity fix when edges are already server-validated to avoid
  // the client's simpler ensureStartEndConnected undoing server repairs
  const connectedEdges = skipConnectivityFix ? edges : ensureStartEndConnected(nodes, edges);

  const layoutedNodes = await layoutWorkflow(nodes, connectedEdges, layoutOptions);

  return {
    nodes: toReactFlowNodes(layoutedNodes, { useCompactNodes, uniformWidth }),
    edges: toReactFlowEdges(connectedEdges),
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Extracts node-specific data based on node type.
 */
function extractNodeSpecificData(node: WorkflowNode): Record<string, unknown> {
  switch (node.type) {
    case 'skill':
      return {
        skillId: node.skillId,
        skillName: node.skillName,
        inputs: node.inputs,
        outputs: node.outputs,
      };
    case 'context':
      return {
        content: node.content,
        args: node.args,
      };
    case 'agent':
      return {
        agentId: node.agentId,
        agentName: node.agentName,
        systemPrompt: node.systemPrompt,
        model: node.model,
        maxTurns: node.maxTurns,
        temperature: node.temperature,
        allowedTools: node.allowedTools,
        handoffs: node.handoffs,
      };
    case 'conditional':
      return {
        expression: node.expression,
        branches: node.branches,
        defaultBranch: node.defaultBranch,
      };
    case 'loop':
      return {
        iteratorVariable: node.iteratorVariable,
        collection: node.collection,
        maxIterations: node.maxIterations,
        breakCondition: node.breakCondition,
        bodyNodeIds: node.bodyNodeIds,
      };
    case 'parallel':
      return {
        branchNodeIds: node.branchNodeIds,
        waitForAll: node.waitForAll,
        maxConcurrency: node.maxConcurrency,
      };
    case 'start':
      return {
        inputs: node.inputs,
      };
    case 'end':
      return {
        outputs: node.outputs,
      };
    default:
      return {};
  }
}

/**
 * Extracts edge-specific data based on edge type.
 */
function extractEdgeSpecificData(edge: WorkflowEdge): Record<string, unknown> {
  switch (edge.type) {
    case 'handoff':
      return {
        context: edge.context,
        preserveHistory: edge.preserveHistory,
      };
    case 'dataflow':
      return {
        sourceOutput: edge.sourceOutput,
        targetInput: edge.targetInput,
        transform: edge.transform,
      };
    case 'conditional':
      return {
        condition: edge.condition,
        priority: edge.priority,
      };
    default:
      return {};
  }
}

/**
 * Maps workflow edge types to registered ReactFlow edge types.
 * Returns the actual edge type to use the custom edge components.
 */
function mapEdgeType(edgeType: WorkflowEdge['type']): string {
  // Map to registered edge types: sequential, handoff, dataflow, conditional
  switch (edgeType) {
    case 'sequential':
      return 'sequential';
    case 'handoff':
    case 'dataflow':
    case 'conditional':
      return edgeType;
    default:
      // Default to sequential for unknown types
      return 'sequential';
  }
}
