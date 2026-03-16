import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { cn } from '@/lib/utils/cn';
import {
  handleVariants,
  nodeIconVariants,
  nodeLabelVariants,
  rectangleNodeVariants,
} from './styles';
import type { LoopNodeData } from './types';

type LoopNodeType = Node<LoopNodeData, 'loop'>;

/**
 * LoopNode - Rectangle with circular arrow icon representing iteration.
 * Has target (top) and source (bottom) handles, plus a loop-back handle.
 */
function LoopNodeComponent({ data, selected }: NodeProps<LoopNodeType>): React.JSX.Element {
  const nodeData = data as LoopNodeData;

  return (
    <div
      className={cn(
        rectangleNodeVariants({ selected: selected ?? false, nodeType: 'loop' }),
        'relative'
      )}
    >
      {/* Target handle - top */}
      <Handle
        type="target"
        position={Position.Top}
        className={cn(handleVariants({ type: 'target' }))}
        id="target"
      />

      {/* Loop back target handle - left side */}
      <Handle
        type="target"
        position={Position.Left}
        className={cn(handleVariants({ type: 'target' }))}
        id="loop-back"
        style={{ left: -6 }}
      />

      <span className={cn(nodeIconVariants({ nodeType: 'loop' }), 'text-xl')} aria-hidden="true">
        &#8635;
      </span>
      <span className={cn(nodeLabelVariants({ nodeType: 'loop' }))} title={nodeData.label}>
        {nodeData.label || 'Loop'}
      </span>
      {nodeData.maxIterations != null ? (
        <span className="text-xs text-fg-muted">max: {nodeData.maxIterations}</span>
      ) : null}

      {/* Source handle - bottom (continue flow) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className={cn(handleVariants({ type: 'source' }))}
        id="source"
      />

      {/* Loop source handle - right side (for looping back) */}
      <Handle
        type="source"
        position={Position.Right}
        className={cn(handleVariants({ type: 'source' }))}
        id="loop"
        style={{ right: -6 }}
      />
    </div>
  );
}

export const LoopNode = memo(LoopNodeComponent);
LoopNode.displayName = 'LoopNode';
