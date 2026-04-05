import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import type { TopologyNode } from '@/lib/topology/types';
import { DECISION_TYPE_CONFIG, getRoleConfig, STATUS_COLORS } from './agent-node-types';

export type AgentNodeData = Pick<
  TopologyNode,
  'name' | 'role' | 'status' | 'progress' | 'decisions' | 'tokens' | 'cost' | 'turns'
> & {
  nodeIndex: number;
  [key: string]: unknown;
};

const RADIUS = 28;
const ARC_R = RADIUS + 4; // 32
const PULSE_R = RADIUS + 8; // 36
const SELECTION_R = RADIUS + 10; // 38
const CIRCUMFERENCE = 2 * Math.PI * ARC_R;
const ICON_SIZE = Math.max(14, RADIUS * 0.6);

function formatTokens(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function AgentNodeComponent({ data, selected }: NodeProps) {
  const { name, role, status, progress, decisions, tokens, cost, turns, agentType } =
    data as AgentNodeData;
  const roleConfig = getRoleConfig(role);
  const roleColor = roleConfig.color;
  const statusColor = STATUS_COLORS[status];
  const pct = Math.min(1, Math.max(0, progress / 100));
  const isRunning = status === 'running';
  const isVerifying = status === 'verifying';

  const lastDecision = decisions.length > 0 ? decisions[decisions.length - 1] : null;
  const decisionConfig = lastDecision ? DECISION_TYPE_CONFIG[lastDecision.type] : null;

  const glowFilter = isRunning
    ? 'url(#agent-glow-running)'
    : isVerifying
      ? 'url(#agent-glow-verifying)'
      : undefined;

  const safeCost = typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
  const safeTokens = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
  const safeTurns = typeof turns === 'number' && Number.isFinite(turns) ? turns : 0;
  const metricsText = `${safeTurns}t · ${formatTokens(safeTokens)} · $${safeCost.toFixed(2)}`;

  return (
    <div style={{ width: 120, height: 145, overflow: 'visible' }}>
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ opacity: 0, width: 1, height: 1 }}
      />

      <svg
        viewBox="-60 -50 120 145"
        width={120}
        height={145}
        overflow="visible"
        role="img"
        aria-label={`${name} - ${roleConfig.label} agent`}
      >
        {/* Running pulse animation */}
        {isRunning && (
          <circle
            cx={0}
            cy={0}
            r={PULSE_R}
            fill={statusColor}
            opacity={0.15}
            style={{
              animation: 'running-pulse 2s ease-in-out infinite',
              transformOrigin: '0 0',
            }}
          />
        )}

        {/* Progress arc background */}
        <circle
          cx={0}
          cy={0}
          r={ARC_R}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={3}
        />

        {/* Progress arc fill */}
        {pct > 0 && (
          <circle
            cx={0}
            cy={0}
            r={ARC_R}
            fill="none"
            stroke={statusColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE * pct} ${CIRCUMFERENCE * (1 - pct)}`}
            transform="rotate(-90)"
          />
        )}

        {/* Selection ring */}
        <circle
          cx={0}
          cy={0}
          r={SELECTION_R}
          fill="none"
          stroke={roleColor}
          strokeWidth={1.5}
          opacity={selected ? 0.8 : 0}
          style={{ transition: 'opacity 200ms' }}
        />

        {/* Main circle */}
        <circle
          cx={0}
          cy={0}
          r={RADIUS}
          fill={roleColor}
          stroke={statusColor}
          strokeWidth={3}
          filter={glowFilter}
        />

        {/* Icon */}
        <text
          x={0}
          y={0}
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={ICON_SIZE}
          fill="var(--bg-canvas)"
          style={{ pointerEvents: 'none' }}
        >
          {roleConfig.icon}
        </text>

        {/* Status dot */}
        <circle
          cx={RADIUS * 0.72}
          cy={-RADIUS * 0.72}
          r={5}
          fill={statusColor}
          stroke="var(--bg-canvas)"
          strokeWidth={1}
        />

        {/* Name label */}
        <text
          x={0}
          y={RADIUS + 20}
          textAnchor="middle"
          fontSize={12}
          fill="var(--fg-default)"
          fontWeight={500}
          style={{ pointerEvents: 'none' }}
        >
          {name}
        </text>

        {/* Sub-label */}
        <text
          x={0}
          y={RADIUS + 42}
          textAnchor="middle"
          fontSize={10}
          fill="var(--fg-muted)"
          style={{ pointerEvents: 'none' }}
        >
          {agentType ? `${agentType} · ` : ''}
          {status} &middot; {progress}%
        </text>

        {/* Metrics row */}
        <text
          x={0}
          y={RADIUS + 56}
          textAnchor="middle"
          fontSize={9}
          fill="var(--fg-subtle)"
          style={{ pointerEvents: 'none' }}
        >
          {metricsText}
        </text>

        {/* Decision badge */}
        {decisionConfig && (
          <g transform={`translate(${RADIUS + 8}, ${-RADIUS - 4})`}>
            <rect
              x={-12}
              y={-12}
              width={24}
              height={24}
              rx={6}
              fill={`${decisionConfig.color}22`}
              stroke={`${decisionConfig.color}66`}
              strokeWidth={1}
            />
            <text
              x={0}
              y={0}
              dominantBaseline="central"
              textAnchor="middle"
              fontSize={12}
              fill={decisionConfig.color}
              style={{ pointerEvents: 'none' }}
            >
              {decisionConfig.icon}
            </text>
          </g>
        )}
      </svg>

      <Handle
        type="source"
        position={Position.Bottom}
        id="source"
        style={{ opacity: 0, width: 1, height: 1 }}
      />
    </div>
  );
}

function areAgentNodePropsEqual(prev: NodeProps, next: NodeProps): boolean {
  if (prev.selected !== next.selected) return false;

  const prevData = prev.data as AgentNodeData;
  const nextData = next.data as AgentNodeData;

  return (
    prevData.name === nextData.name &&
    prevData.status === nextData.status &&
    prevData.role === nextData.role &&
    prevData.progress === nextData.progress &&
    prevData.decisions === nextData.decisions &&
    prevData.tokens === nextData.tokens &&
    prevData.cost === nextData.cost &&
    prevData.turns === nextData.turns
  );
}

export const AgentNode = memo(AgentNodeComponent, areAgentNodePropsEqual);
AgentNode.displayName = 'AgentNode';
