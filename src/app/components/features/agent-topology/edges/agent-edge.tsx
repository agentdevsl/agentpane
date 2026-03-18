import { type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { memo } from 'react';
import type { TopologyAgentStatus } from '@/lib/topology/types';
import { STATUS_COLORS } from '../nodes/agent-node-types';

interface AgentEdgeData extends Record<string, unknown> {
  sourceStatus: TopologyAgentStatus;
  targetStatus: TopologyAgentStatus;
}

type EdgeStatus = 'running' | 'completed' | 'pending';

function deriveEdgeStatus(
  sourceStatus: TopologyAgentStatus,
  targetStatus: TopologyAgentStatus
): EdgeStatus {
  if (
    sourceStatus === 'completed' &&
    (targetStatus === 'running' || targetStatus === 'completed')
  ) {
    return 'completed';
  }
  if (sourceStatus === 'running' || targetStatus === 'running') {
    return 'running';
  }
  return 'pending';
}

function AgentEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as AgentEdgeData | undefined;
  const sourceStatus = edgeData?.sourceStatus ?? 'queued';
  const targetStatus = edgeData?.targetStatus ?? 'queued';
  const edgeStatus = deriveEdgeStatus(sourceStatus, targetStatus);

  const sourceColor = STATUS_COLORS[sourceStatus];
  const targetColor = STATUS_COLORS[targetStatus];

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 20,
  });

  const gradientId = `agent-edge-gradient-${id}`;

  const isRunning = edgeStatus === 'running';
  const isCompleted = edgeStatus === 'completed';
  const isPending = edgeStatus === 'pending';

  const markerEnd = isRunning
    ? 'url(#agent-arrow-running)'
    : isCompleted
      ? 'url(#agent-arrow-completed)'
      : 'url(#agent-arrow-default)';

  const strokeDasharray = isRunning ? '8 5' : isPending ? '3 5' : undefined;
  const strokeOpacity = isCompleted ? 0.5 : isPending ? 0.4 : 1;

  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>
      </defs>

      {/* Main edge path */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={2}
        strokeDasharray={strokeDasharray}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={markerEnd}
        opacity={strokeOpacity}
        className="react-flow__edge-path"
        style={isRunning ? { animation: 'agent-dash-flow 1.5s linear infinite' } : undefined}
      />

      {/* Animated particles for running edges */}
      {isRunning && (
        <>
          <circle r="2.5" fill={sourceColor} opacity="0.8">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} begin="0s" />
          </circle>
          <circle r="2" fill={targetColor} opacity="0.6">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} begin="1s" />
          </circle>
        </>
      )}
    </>
  );
}

function areAgentEdgePropsEqual(prev: EdgeProps, next: EdgeProps): boolean {
  if (
    prev.sourceX !== next.sourceX ||
    prev.sourceY !== next.sourceY ||
    prev.targetX !== next.targetX ||
    prev.targetY !== next.targetY ||
    prev.sourcePosition !== next.sourcePosition ||
    prev.targetPosition !== next.targetPosition
  ) {
    return false;
  }

  const prevData = prev.data as AgentEdgeData | undefined;
  const nextData = next.data as AgentEdgeData | undefined;

  return (
    prevData?.sourceStatus === nextData?.sourceStatus &&
    prevData?.targetStatus === nextData?.targetStatus
  );
}

export const AgentEdge = memo(AgentEdgeComponent, areAgentEdgePropsEqual);
AgentEdge.displayName = 'AgentEdge';
