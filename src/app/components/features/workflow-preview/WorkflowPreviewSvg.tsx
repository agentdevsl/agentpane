import { useMemo } from 'react';
import { NODE_COLORS } from '@/lib/constants/node-colors';
import { cn } from '@/lib/utils/cn';
import type { NodeType, WorkflowEdge, WorkflowNode } from '@/lib/workflow-dsl/types';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowPreviewSvgProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width?: number;
  height?: number;
  className?: string;
}

// =============================================================================
// Constants - Aligned with compact-nodes.css design system
// =============================================================================

const EDGE_COLOR = '#30363d'; // --border-default
const TEXT_COLOR = '#e6edf3'; // --fg-default
const MUTED_TEXT_COLOR = '#8b949e'; // --fg-muted
const BG_DEFAULT = '#161b22'; // --bg-default

// Badge dimensions (matching compact-nodes.css)
const BADGE_HEIGHT = {
  mini: 16,
  large: 24,
};
const BADGE_RADIUS = {
  mini: 8,
  large: 12,
};
const BADGE_PADDING = {
  mini: 4,
  large: 8,
};
const BADGE_GAP = {
  mini: 6,
  large: 12,
};
const ICON_SIZE = {
  mini: 8,
  large: 12,
};
const FONT_SIZE = {
  mini: 7,
  large: 10,
};
// Minimum badge width to ensure readability
const MIN_BADGE_WIDTH = {
  mini: 24,
  large: 50,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate text width approximation
 */
function measureText(text: string, fontSize: number): number {
  // Average character width is ~0.55 of font size for Mona Sans
  return text.length * fontSize * 0.55;
}

/**
 * Get badge width based on label length and available space
 */
function getBadgeWidth(label: string, size: 'mini' | 'large', maxChars: number): number {
  const fontSize = FONT_SIZE[size];
  const padding = BADGE_PADDING[size];
  const iconSize = ICON_SIZE[size];
  const iconGap = size === 'mini' ? 2 : 4;

  // Truncate for width calculation
  const displayLabel = label.length > maxChars ? label.slice(0, maxChars) : label;
  const textWidth = measureText(displayLabel, fontSize);

  return Math.max(iconSize + iconGap + textWidth + padding * 2, MIN_BADGE_WIDTH[size]);
}

/**
 * Mini dot layout - simple colored dots for small preview thumbnails
 */
function layoutDots(
  nodes: WorkflowNode[],
  targetWidth: number,
  targetHeight: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const padding = 4;
  const dotSize = 6;
  const hGap = 3;
  const vGap = 4;
  const availableWidth = targetWidth - padding * 2;
  const availableHeight = targetHeight - padding * 2;

  // Calculate how many dots fit per row
  const dotsPerRow = Math.floor((availableWidth + hGap) / (dotSize + hGap));
  const rows = Math.ceil(nodes.length / dotsPerRow);

  // Calculate total height and center vertically
  const totalHeight = rows * dotSize + (rows - 1) * vGap;
  const startY = padding + (availableHeight - totalHeight) / 2 + dotSize / 2;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;

    const row = Math.floor(i / dotsPerRow);
    const col = i % dotsPerRow;
    const nodesInRow = Math.min(dotsPerRow, nodes.length - row * dotsPerRow);

    // Center each row
    const rowWidth = nodesInRow * dotSize + (nodesInRow - 1) * hGap;
    const startX = padding + (availableWidth - rowWidth) / 2 + dotSize / 2;

    positions.set(node.id, {
      x: startX + col * (dotSize + hGap),
      y: startY + row * (dotSize + vGap),
    });
  }

  return positions;
}

/**
 * Linear wrapping layout - nodes flow left to right, targeting 2 rows.
 * Dynamically adjusts label truncation to fit nodes within available space.
 * Node order: start first, middle nodes by position, end last.
 */
function layoutLinear(
  nodes: WorkflowNode[],
  targetWidth: number,
  targetHeight: number,
  size: 'mini' | 'large'
): { positions: Map<string, { x: number; y: number; width: number }>; maxChars: number } {
  const positions = new Map<string, { x: number; y: number; width: number }>();
  if (nodes.length === 0) return { positions, maxChars: 8 };

  const padding = size === 'mini' ? 6 : 16;
  const availableWidth = targetWidth - padding * 2;
  const availableHeight = targetHeight - padding * 2;
  const hGap = BADGE_GAP[size];
  const vGap = size === 'mini' ? 8 : 12;
  const badgeHeight = BADGE_HEIGHT[size];

  // Target exactly 2 rows
  const targetRows = 2;

  // Try different maxChars values to fit all nodes in 2 rows
  let bestMaxChars = size === 'mini' ? 12 : 20;
  let rows: WorkflowNode[][] = [];

  for (let maxChars = bestMaxChars; maxChars >= 2; maxChars--) {
    rows = [];
    let currentRow: WorkflowNode[] = [];
    let currentRowWidth = 0;

    for (const node of nodes) {
      const badgeWidth = getBadgeWidth(node.label, size, maxChars);
      const neededWidth = currentRow.length > 0 ? badgeWidth + hGap : badgeWidth;

      if (currentRowWidth + neededWidth <= availableWidth) {
        currentRow.push(node);
        currentRowWidth += neededWidth;
      } else {
        if (currentRow.length > 0) {
          rows.push(currentRow);
        }
        currentRow = [node];
        currentRowWidth = badgeWidth;
      }
    }

    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    if (rows.length <= targetRows) {
      bestMaxChars = maxChars;
      break;
    }
  }

  // Calculate total height and vertical centering
  const totalRowHeight = rows.length * badgeHeight + (rows.length - 1) * vGap;
  const startY = padding + (availableHeight - totalRowHeight) / 2 + badgeHeight / 2;

  // Position each node - left align all rows for clean linear flow
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row) continue;

    // Calculate row width
    const rowBadgeWidths: number[] = [];
    for (const node of row) {
      const w = getBadgeWidth(node.label, size, bestMaxChars);
      rowBadgeWidths.push(w);
    }

    // Left align rows for clean linear reading
    let x = padding;
    const y = startY + rowIdx * (badgeHeight + vGap);

    for (let nodeIdx = 0; nodeIdx < row.length; nodeIdx++) {
      const node = row[nodeIdx];
      const width = rowBadgeWidths[nodeIdx];
      if (!node || width === undefined) continue;

      positions.set(node.id, { x: x + width / 2, y, width });
      x += width + hGap;
    }
  }

  return { positions, maxChars: bestMaxChars };
}

// =============================================================================
// SVG Icon Components (inline for performance)
// =============================================================================

interface IconProps {
  size: number;
  color: string;
}

function PlayIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  );
}

function StopIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function LightningIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />
    </svg>
  );
}

function TerminalIcon({ size, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="3"
      aria-hidden="true"
    >
      <polyline points="4,17 10,11 4,5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function RobotIcon({ size, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <circle cx="8.5" cy="15" r="1" fill={color} />
      <circle cx="15.5" cy="15" r="1" fill={color} />
      <path d="M9 6V4.5a3 3 0 0 1 6 0V6" />
    </svg>
  );
}

function LogicIcon({ size, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <path d="M4 12h4l3 -6l4 12l3 -6h6" />
    </svg>
  );
}

const NODE_TYPE_ICONS: Partial<Record<NodeType, typeof PlayIcon>> = {
  start: PlayIcon,
  end: StopIcon,
  skill: LightningIcon,
  context: TerminalIcon,
  agent: RobotIcon,
};

// =============================================================================
// Badge Node Component
// =============================================================================

interface BadgeNodeProps {
  node: WorkflowNode;
  x: number;
  y: number;
  width: number;
  size: 'mini' | 'large';
  maxChars: number;
}

function BadgeNode({ node, x, y, width, size, maxChars }: BadgeNodeProps) {
  const colors = NODE_COLORS[node.type];
  const height = BADGE_HEIGHT[size];
  const radius = BADGE_RADIUS[size];
  const iconSize = ICON_SIZE[size];
  const fontSize = FONT_SIZE[size];
  const isStartOrEnd = node.type === 'start' || node.type === 'end';

  // Position calculations
  const rectX = x - width / 2;
  const rectY = y - height / 2;
  const iconX = rectX + (size === 'mini' ? 3 : 6);
  const iconY = y - iconSize / 2;
  const textX = iconX + iconSize + (size === 'mini' ? 2 : 4);

  // Truncate label based on calculated maxChars
  const displayLabel =
    node.label.length > maxChars ? `${node.label.slice(0, maxChars)}\u2026` : node.label;

  const iconColor = isStartOrEnd ? BG_DEFAULT : colors.fill;
  const IconComponent = NODE_TYPE_ICONS[node.type] ?? LogicIcon;

  return (
    <g>
      {/* Badge background */}
      <rect
        x={rectX}
        y={rectY}
        width={width}
        height={height}
        rx={radius}
        fill={isStartOrEnd ? colors.fillMuted : BG_DEFAULT}
        stroke={colors.stroke}
        strokeWidth={1}
      />

      {/* Icon circle background */}
      <circle
        cx={iconX + iconSize / 2}
        cy={y}
        r={iconSize / 2 + (size === 'mini' ? 1 : 2)}
        fill={isStartOrEnd ? colors.fill : colors.fillMuted}
      />

      {/* Icon */}
      <g transform={`translate(${iconX}, ${iconY})`}>
        <IconComponent size={iconSize} color={iconColor} />
      </g>

      {/* Label text */}
      <text
        x={textX}
        y={y}
        dominantBaseline="central"
        fill={TEXT_COLOR}
        fontSize={fontSize}
        fontFamily="'Mona Sans', system-ui, sans-serif"
        fontWeight={500}
      >
        <tspan>{displayLabel}</tspan>
      </text>
    </g>
  );
}

// =============================================================================
// WorkflowPreviewSvg Component
// =============================================================================

export function WorkflowPreviewSvg({
  nodes,
  edges,
  width = 64,
  height = 48,
  className,
}: WorkflowPreviewSvgProps): React.JSX.Element {
  // Size threshold: 200px+ renders full badge labels, smaller renders compact dots
  const size: 'mini' | 'large' = width > 200 ? 'large' : 'mini';

  // Sort nodes: start first, then middle nodes by position, then end last
  // Single pass to classify nodes into start, end, and middle
  const sortedNodes = useMemo(() => {
    if (nodes.length === 0) return [];

    let startNode: WorkflowNode | undefined;
    let endNode: WorkflowNode | undefined;
    const middleNodes: WorkflowNode[] = [];

    for (const n of nodes) {
      if (n.type === 'start') startNode = n;
      else if (n.type === 'end') endNode = n;
      else middleNodes.push(n);
    }

    // Sort by dominant axis: if workflow is more vertical than horizontal,
    // sort by Y position; otherwise sort by X for natural reading order
    const xRange =
      Math.max(...middleNodes.map((n) => n.position.x), 0) -
      Math.min(...middleNodes.map((n) => n.position.x), 0);
    const yRange =
      Math.max(...middleNodes.map((n) => n.position.y), 0) -
      Math.min(...middleNodes.map((n) => n.position.y), 0);

    const sortedMiddle = [...middleNodes].sort((a, b) => {
      if (yRange > xRange) {
        return a.position.y - b.position.y;
      }
      return a.position.x - b.position.x;
    });

    // Build result: start -> middle -> end
    const result: WorkflowNode[] = [];
    if (startNode) result.push(startNode);
    result.push(...sortedMiddle);
    if (endNode) result.push(endNode);

    return result;
  }, [nodes]);

  // Use dots for mini size, badges for large
  const dotPositions = useMemo(() => {
    if (size !== 'mini') return null;
    return layoutDots(sortedNodes, width, height);
  }, [sortedNodes, width, height, size]);

  // Use linear wrapping layout for large size
  const { positions: badgePositions, maxChars } = useMemo(() => {
    if (size === 'mini') return { positions: new Map(), maxChars: 0 };
    return layoutLinear(sortedNodes, width, height, size);
  }, [sortedNodes, width, height, size]);

  // Empty state
  if (nodes.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={cn('bg-canvas', className)}
        role="img"
        aria-label="Empty workflow"
      >
        <rect
          x={2}
          y={2}
          width={width - 4}
          height={height - 4}
          fill="none"
          stroke={EDGE_COLOR}
          strokeWidth={1}
          strokeDasharray="4 2"
          rx={4}
        />
        {size === 'large' ? (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={MUTED_TEXT_COLOR}
            fontSize={12}
            fontFamily="'Mona Sans', system-ui, sans-serif"
          >
            No nodes yet
          </text>
        ) : null}
      </svg>
    );
  }

  // Mini size: render simple dots
  if (size === 'mini' && dotPositions) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={cn('bg-canvas', className)}
        role="img"
        aria-label={`Workflow with ${nodes.length} nodes`}
      >
        {sortedNodes.map((node) => {
          const pos = dotPositions.get(node.id);
          if (!pos) return null;
          const colors = NODE_COLORS[node.type];

          return <circle key={node.id} cx={pos.x} cy={pos.y} r={3} fill={colors.fill} />;
        })}
      </svg>
    );
  }

  // Build connection lines between sequential nodes for large size
  const connections: Array<{
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    isWrap: boolean;
  }> = [];
  for (let i = 0; i < sortedNodes.length - 1; i++) {
    const currentNode = sortedNodes[i];
    const nextNode = sortedNodes[i + 1];
    if (!currentNode || !nextNode) continue;

    const currentPos = badgePositions.get(currentNode.id);
    const nextPos = badgePositions.get(nextNode.id);
    if (!currentPos || !nextPos) continue;

    const isWrap = currentPos.y !== nextPos.y;
    connections.push({
      id: `${currentNode.id}-${nextNode.id}`,
      x1: currentPos.x + currentPos.width / 2,
      y1: currentPos.y,
      x2: nextPos.x - nextPos.width / 2,
      y2: nextPos.y,
      isWrap,
    });
  }

  // Large size: render badges with connections
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('bg-canvas', className)}
      role="img"
      aria-label={`Workflow with ${nodes.length} nodes and ${edges.length} edges`}
    >
      {/* Connection lines */}
      {connections.map((conn) => {
        if (conn.isWrap) {
          // Wrap connection - curved line to next row
          return (
            <path
              key={conn.id}
              d={`M ${conn.x1} ${conn.y1}
                  C ${conn.x1 + 20} ${conn.y1}, ${conn.x2 - 20} ${conn.y2}, ${conn.x2} ${conn.y2}`}
              stroke={EDGE_COLOR}
              strokeWidth={1.5}
              fill="none"
              opacity={0.5}
            />
          );
        }
        // Same row - simple horizontal line
        return (
          <line
            key={conn.id}
            x1={conn.x1}
            y1={conn.y1}
            x2={conn.x2}
            y2={conn.y2}
            stroke={EDGE_COLOR}
            strokeWidth={1.5}
          />
        );
      })}

      {/* Nodes */}
      {sortedNodes.map((node) => {
        const pos = badgePositions.get(node.id);
        if (!pos) return null;

        return (
          <BadgeNode
            key={node.id}
            node={node}
            x={pos.x}
            y={pos.y}
            width={pos.width}
            size={size}
            maxChars={maxChars}
          />
        );
      })}
    </svg>
  );
}
