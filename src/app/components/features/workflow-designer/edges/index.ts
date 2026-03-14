/**
 * Workflow Designer Edge Types Registry
 *
 * Custom edge components for ReactFlow 12 workflow visualization.
 *
 * Edge Types:
 * - sequential: Solid arrow for default workflow flow
 * - handoff: Labeled arrow with dot marker for agent handoffs
 * - dataflow: Dashed arrow for data transfer between nodes
 * - conditional: Reuses sequential edge with condition label support
 */

import { DataflowEdge, type DataflowEdgeData } from './DataflowEdge';
import { HandoffEdge, type HandoffEdgeData } from './HandoffEdge';
import { SequentialEdge, type SequentialEdgeData } from './SequentialEdge';

/**
 * Edge type registry for ReactFlow
 *
 * Usage:
 * ```tsx
 * import { edgeTypes } from './edges';
 *
 * <ReactFlow
 *   nodes={nodes}
 *   edges={edges}
 *   edgeTypes={edgeTypes}
 * />
 * ```
 */
export const edgeTypes = {
  sequential: SequentialEdge,
  handoff: HandoffEdge,
  dataflow: DataflowEdge,
  conditional: SequentialEdge, // Reuse with different styling via data.condition
} as const;

export type EdgeType = keyof typeof edgeTypes;

// Re-export data types for edge configuration
export type { DataflowEdgeData, HandoffEdgeData, SequentialEdgeData };
// Re-export individual components
export { DataflowEdge, HandoffEdge, SequentialEdge };
