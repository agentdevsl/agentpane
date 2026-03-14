import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { cn } from '@/lib/utils/cn';
import { forkNodeVariants, handleVariants, nodeIconVariants, nodeLabelVariants } from './styles';
import type { ParallelNodeData } from './types';

type ParallelNodeType = Node<ParallelNodeData, 'parallel'>;

/**
 * ParallelNode - Fork shape representing parallel execution branches.
 * Has target (top) and multiple source handles for parallel branches.
 */
function ParallelNodeComponent({ data, selected }: NodeProps<ParallelNodeType>): React.JSX.Element {
  const nodeData = data as ParallelNodeData;
  const branchCount = nodeData.branchCount ?? 2;

  return (
    <div className={cn(forkNodeVariants({ selected: selected ?? false }), 'relative')}>
      {/* Target handle - top */}
      <Handle
        type="target"
        position={Position.Top}
        className={cn(handleVariants({ type: 'target' }))}
        id="target"
      />

      {/* Fork icon using parallel lines */}
      <div className="flex items-center gap-1" aria-hidden="true">
        <span className={cn(nodeIconVariants({ nodeType: 'parallel' }), 'text-lg')}>&#9776;</span>
        <div className="flex flex-col gap-0.5">
          <div className="w-4 h-0.5 bg-secondary rounded" />
          <div className="w-4 h-0.5 bg-secondary rounded" />
          <div className="w-4 h-0.5 bg-secondary rounded" />
        </div>
      </div>

      <span className={cn(nodeLabelVariants({ nodeType: 'parallel' }))} title={nodeData.label}>
        {nodeData.label || 'Parallel'}
      </span>
      <span className="text-xs text-fg-muted">{branchCount} branches</span>

      {/* Multiple source handles at bottom for parallel branches */}
      {Array.from({ length: branchCount }, (_, i) => {
        const offset = (i - (branchCount - 1) / 2) * 24;
        return (
          <Handle
            key={`branch-${i}`}
            type="source"
            position={Position.Bottom}
            className={cn(handleVariants({ type: 'source' }))}
            id={`branch-${i}`}
            style={{ left: `calc(50% + ${offset}px)` }}
          />
        );
      })}
    </div>
  );
}

export const ParallelNode = memo(ParallelNodeComponent);
ParallelNode.displayName = 'ParallelNode';
