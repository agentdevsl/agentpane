import { type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { memo } from 'react';

function SkillEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <path
      id={id}
      d={edgePath}
      fill="none"
      stroke="var(--accent-muted, rgba(56, 139, 253, 0.4))"
      strokeWidth={1.5}
      strokeDasharray="6 4"
      strokeLinecap="round"
      strokeLinejoin="round"
      markerEnd="url(#skill-arrow)"
      opacity={0.7}
      className="react-flow__edge-path"
    />
  );
}

function areSkillEdgePropsEqual(prev: EdgeProps, next: EdgeProps): boolean {
  return (
    prev.sourceX === next.sourceX &&
    prev.sourceY === next.sourceY &&
    prev.targetX === next.targetX &&
    prev.targetY === next.targetY &&
    prev.sourcePosition === next.sourcePosition &&
    prev.targetPosition === next.targetPosition
  );
}

export const SkillEdge = memo(SkillEdgeComponent, areSkillEdgePropsEqual);
SkillEdge.displayName = 'SkillEdge';
