/**
 * Compact Workflow Nodes - v3 Design
 *
 * Ultra compact ~32px height nodes with:
 * - Single-line layout: Icon (22px) + Label · command + micro badge (7px font)
 * - Staggered entry animations with 50ms delays
 * - Hover effects: scale 1.02 + lift -2px + shadow
 * - Icon hover: scale 1.1 + 5deg rotate
 * - Start node: pulsing glow shadow (2.5s cycle)
 *
 * Based on: specs/application/wireframes/workflow-nodes-pill-v3.html
 */

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { cn } from '@/lib/utils/cn';
import type {
  AgentNodeData,
  ContextNodeData,
  EndNodeData,
  SkillNodeData,
  StartNodeData,
} from './types';
import './compact-nodes.css';

// ===== SVG Icons (constant JSX for optimal performance — no component overhead) =====

const playIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="5,3 19,12 5,21" />
  </svg>
);

const stopIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const terminalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <polyline points="4,17 10,11 4,5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const lightningIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />
  </svg>
);

const robotIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="8" cy="16" r="1.5" fill="currentColor" />
    <circle cx="16" cy="16" r="1.5" fill="currentColor" />
    <path d="M9 7V5a3 3 0 0 1 6 0v2" />
  </svg>
);

// ===== Compact Start Node =====

type CompactStartNodeType = Node<StartNodeData, 'compactStart'>;

function CompactStartNodeComponent({
  data,
  selected,
}: NodeProps<CompactStartNodeType>): React.JSX.Element {
  const nodeData = data as StartNodeData;
  const nodeIndex = (nodeData as StartNodeData & { nodeIndex?: number }).nodeIndex ?? 0;
  const uniformWidth = (nodeData as StartNodeData & { uniformWidth?: number }).uniformWidth;

  return (
    <div
      className={cn('compact-node start', selected && 'selected')}
      data-node-index={nodeIndex}
      style={
        uniformWidth
          ? ({ '--compact-node-uniform-width': `${uniformWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div className="compact-node-icon">{playIcon}</div>
      <div className="compact-node-content">
        <span className="compact-node-label">{nodeData.label || 'Start'}</span>
      </div>

      {/* Source handle - bottom only */}
      <Handle type="source" position={Position.Bottom} id="source" />
    </div>
  );
}

export const CompactStartNode = memo(CompactStartNodeComponent);
CompactStartNode.displayName = 'CompactStartNode';

// ===== Compact End Node =====

type CompactEndNodeType = Node<EndNodeData, 'compactEnd'>;

function CompactEndNodeComponent({
  data,
  selected,
}: NodeProps<CompactEndNodeType>): React.JSX.Element {
  const nodeData = data as EndNodeData;
  const nodeIndex = (nodeData as EndNodeData & { nodeIndex?: number }).nodeIndex ?? 0;
  const uniformWidth = (nodeData as EndNodeData & { uniformWidth?: number }).uniformWidth;

  return (
    <div
      className={cn('compact-node end', selected && 'selected')}
      data-node-index={nodeIndex}
      style={
        uniformWidth
          ? ({ '--compact-node-uniform-width': `${uniformWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Target handle - top only */}
      <Handle type="target" position={Position.Top} id="target" />

      <div className="compact-node-icon">{stopIcon}</div>
      <div className="compact-node-content">
        <span className="compact-node-label">{nodeData.label || 'Done'}</span>
      </div>
    </div>
  );
}

export const CompactEndNode = memo(CompactEndNodeComponent);
CompactEndNode.displayName = 'CompactEndNode';

// ===== Compact Context Node =====

type CompactContextNodeType = Node<ContextNodeData, 'compactContext'>;

function CompactContextNodeComponent({
  data,
  selected,
}: NodeProps<CompactContextNodeType>): React.JSX.Element {
  const nodeData = data as ContextNodeData;
  const nodeIndex = (nodeData as ContextNodeData & { nodeIndex?: number }).nodeIndex ?? 0;
  const uniformWidth = (nodeData as ContextNodeData & { uniformWidth?: number }).uniformWidth;

  // Display the context content, truncated if needed
  const displayContext = nodeData.content || nodeData.label || 'context';

  return (
    <div
      className={cn('compact-node context', selected && 'selected')}
      data-node-index={nodeIndex}
      style={
        uniformWidth
          ? ({ '--compact-node-uniform-width': `${uniformWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Target handle - top */}
      <Handle type="target" position={Position.Top} id="target" />

      <div className="compact-node-icon">{terminalIcon}</div>
      <div className="compact-node-content">
        <span className="compact-node-label">{nodeData.label}</span>
        {displayContext && displayContext !== nodeData.label && (
          <>
            <span className="compact-node-sep" />
            <span className="compact-node-cmd" title={displayContext}>
              {displayContext}
            </span>
          </>
        )}
      </div>
      <span className="compact-node-type">ctx</span>

      {/* Source handle - bottom */}
      <Handle type="source" position={Position.Bottom} id="source" />
    </div>
  );
}

export const CompactContextNode = memo(CompactContextNodeComponent);
CompactContextNode.displayName = 'CompactContextNode';

// ===== Compact Skill Node =====

type CompactSkillNodeType = Node<SkillNodeData, 'compactSkill'>;

function CompactSkillNodeComponent({
  data,
  selected,
}: NodeProps<CompactSkillNodeType>): React.JSX.Element {
  const nodeData = data as SkillNodeData;
  const nodeIndex = (nodeData as SkillNodeData & { nodeIndex?: number }).nodeIndex ?? 0;
  const uniformWidth = (nodeData as SkillNodeData & { uniformWidth?: number }).uniformWidth;

  // Display the skill ID if different from label
  const displaySkillId = nodeData.skillId || nodeData.label || 'skill';

  return (
    <div
      className={cn('compact-node skill', selected && 'selected')}
      data-node-index={nodeIndex}
      style={
        uniformWidth
          ? ({ '--compact-node-uniform-width': `${uniformWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Target handle - top */}
      <Handle type="target" position={Position.Top} id="target" />

      <div className="compact-node-icon">{lightningIcon}</div>
      <div className="compact-node-content">
        <span className="compact-node-label">{nodeData.label}</span>
        {displaySkillId && displaySkillId !== nodeData.label && (
          <>
            <span className="compact-node-sep" />
            <span className="compact-node-cmd" title={displaySkillId}>
              {displaySkillId}
            </span>
          </>
        )}
      </div>
      <span className="compact-node-type">skill</span>

      {/* Source handle - bottom */}
      <Handle type="source" position={Position.Bottom} id="source" />
    </div>
  );
}

export const CompactSkillNode = memo(CompactSkillNodeComponent);
CompactSkillNode.displayName = 'CompactSkillNode';

// ===== Compact Agent Node =====

type CompactAgentNodeType = Node<AgentNodeData, 'compactAgent'>;

function CompactAgentNodeComponent({
  data,
  selected,
}: NodeProps<CompactAgentNodeType>): React.JSX.Element {
  const nodeData = data as AgentNodeData;
  const nodeIndex = (nodeData as AgentNodeData & { nodeIndex?: number }).nodeIndex ?? 0;
  const uniformWidth = (nodeData as AgentNodeData & { uniformWidth?: number }).uniformWidth;

  // Display agent config or model info
  const displayInfo = nodeData.agentConfigId || 'agent';

  return (
    <div
      className={cn('compact-node agent', selected && 'selected')}
      data-node-index={nodeIndex}
      style={
        uniformWidth
          ? ({ '--compact-node-uniform-width': `${uniformWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Target handle - top */}
      <Handle type="target" position={Position.Top} id="target" />

      <div className="compact-node-icon">{robotIcon}</div>
      <div className="compact-node-content">
        <span className="compact-node-label">{nodeData.label}</span>
        {displayInfo && displayInfo !== nodeData.label && (
          <>
            <span className="compact-node-sep" />
            <span className="compact-node-cmd" title={displayInfo}>
              {displayInfo}
            </span>
          </>
        )}
      </div>
      <span className="compact-node-type">agent</span>

      {/* Source handle - bottom */}
      <Handle type="source" position={Position.Bottom} id="source" />
    </div>
  );
}

export const CompactAgentNode = memo(CompactAgentNodeComponent);
CompactAgentNode.displayName = 'CompactAgentNode';

// ===== Export compact node types registry =====

export const compactNodeTypes = {
  compactStart: CompactStartNode,
  compactEnd: CompactEndNode,
  compactContext: CompactContextNode,
  compactSkill: CompactSkillNode,
  compactAgent: CompactAgentNode,
} as const;

export type CompactNodeType = keyof typeof compactNodeTypes;
