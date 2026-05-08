import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';

/**
 * Invisible 1×1 node used as the edge target for skill→cluster
 * connections. Positioned at the cluster box's top-centre by the
 * layout pass, so the dashed skill line visually terminates at the
 * cluster outline rather than at one specific member inside the box.
 *
 * We can't render an edge to the cluster box directly — the box is a
 * div overlay (TopologyGroupOverlay), not a ReactFlow node — so this
 * synthetic node bridges the gap.
 */
function ClusterAnchorNodeComponent(_: NodeProps) {
  return (
    <div
      style={{
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source"
        style={{ opacity: 0, width: 1, height: 1 }}
      />
    </div>
  );
}

export const ClusterAnchorNode = memo(ClusterAnchorNodeComponent);
ClusterAnchorNode.displayName = 'ClusterAnchorNode';
