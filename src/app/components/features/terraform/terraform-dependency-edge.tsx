import { EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { memo, useState } from 'react';
import { cn } from '@/lib/utils/cn';

export interface TerraformEdgeData extends Record<string, unknown> {
  edgeType: 'explicit' | 'implicit';
  outputs?: string;
  elkPoints?: Array<{ x: number; y: number }> | null;
}

type Point = { x: number; y: number };

/** Convert ELK bend points to an SVG path with rounded corners via quadratic bezier. */
function pointsToSvgPath(points: [Point, Point, ...Point[]], cornerRadius: number): string {
  const [first, second] = points;

  if (points.length === 2) {
    return `M ${first.x} ${first.y} L ${second.x} ${second.y}`;
  }

  let d = `M ${first.x} ${first.y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const curr = points[i] as Point;
    const next = points[i + 1] as Point;

    const dxPrev = prev.x - curr.x;
    const dyPrev = prev.y - curr.y;
    const dxNext = next.x - curr.x;
    const dyNext = next.y - curr.y;

    const lenPrev = Math.sqrt(dxPrev * dxPrev + dyPrev * dyPrev);
    const lenNext = Math.sqrt(dxNext * dxNext + dyNext * dyNext);

    // Clamp radius so it doesn't exceed half the segment length
    const clampedR = Math.min(cornerRadius, lenPrev / 2, lenNext / 2);

    // Points where the rounding starts/ends
    const startX = curr.x + (dxPrev / lenPrev) * clampedR;
    const startY = curr.y + (dyPrev / lenPrev) * clampedR;
    const endX = curr.x + (dxNext / lenNext) * clampedR;
    const endY = curr.y + (dyNext / lenNext) * clampedR;

    d += ` L ${startX} ${startY}`;
    d += ` Q ${curr.x} ${curr.y} ${endX} ${endY}`;
  }

  const last = points[points.length - 1] as Point;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Walk the polyline segments and find the geometric midpoint along total length. */
function computeLabelPosition(points: [Point, Point, ...Point[]]): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    lengths.push(len);
    total += len;
  }

  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    const segLen = lengths[i] as number;
    if (acc + segLen >= half) {
      const t = (half - acc) / segLen;
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      };
    }
    acc += segLen;
  }

  return points[points.length - 1] as Point;
}

/** SVG marker + gradient definitions — rendered once inside the ReactFlow SVG layer. */
export function TerraformEdgeMarkers(): React.JSX.Element {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {/* Explicit edge arrow — filled blue chevron */}
        <marker
          id="tf-arrow-explicit"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L7,4 L1,7"
            fill="none"
            stroke="var(--accent-fg)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Implicit edge arrow — subtle gray */}
        <marker
          id="tf-arrow-implicit"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L7,4 L1,7"
            fill="none"
            stroke="var(--fg-subtle)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Animated flow dot for explicit edges */}
        <circle id="tf-flow-dot" r="2" fill="var(--accent-fg)" opacity="0.8" />
      </defs>
    </svg>
  );
}

function TerraformDependencyEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as TerraformEdgeData | undefined;
  const isExplicit = edgeData?.edgeType === 'explicit';
  const outputs = edgeData?.outputs;
  const elkPoints = edgeData?.elkPoints;
  const [hovered, setHovered] = useState(false);

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (elkPoints && elkPoints.length >= 2) {
    const first = elkPoints[0] as Point;
    const last = elkPoints[elkPoints.length - 1] as Point;

    // Detect backward edges (source below target in a DOWN layout).
    // ELK routes these as huge rectangular detours — instead, draw a smooth
    // cubic bezier curve that arcs to the right of the nodes.
    if (first.y > last.y + 10) {
      const dy = first.y - last.y;
      const curveOffset = Math.max(80, dy * 0.35);
      edgePath = `M ${first.x} ${first.y} C ${first.x + curveOffset} ${first.y}, ${last.x + curveOffset} ${last.y}, ${last.x} ${last.y}`;
      labelX = Math.max(first.x, last.x) + curveOffset * 0.45;
      labelY = (first.y + last.y) / 2;
    } else {
      // Forward edge — use ELK's computed routing directly
      edgePath = pointsToSvgPath(elkPoints as [Point, Point, ...Point[]], 8);
      const mid = computeLabelPosition(elkPoints as [Point, Point, ...Point[]]);
      labelX = mid.x;
      labelY = mid.y;
    }
  } else {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 12,
    });
  }

  // Edge colours derive from the accent / muted-foreground tokens so the
  // diagram tracks light/dark theme switches.
  const stroke = isExplicit ? 'var(--accent-fg)' : 'var(--fg-subtle)';
  const hoverStroke = isExplicit ? 'var(--accent-hover)' : 'var(--fg-muted)';

  return (
    <>
      {/* Invisible wide hit area for hover detection */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG edge hover zone, not interactive content */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        strokeLinecap="round"
        className="react-flow__edge-interaction"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Glow layer for explicit edges */}
      {isExplicit && (
        <path
          d={edgePath}
          fill="none"
          stroke="var(--accent-fg)"
          strokeWidth={hovered ? 10 : 6}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={hovered ? 0.12 : 0.05}
          className="react-flow__edge-path"
          style={{ transition: 'stroke-width 200ms, opacity 200ms' }}
        />
      )}
      {/* Main edge path */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={hovered ? hoverStroke : stroke}
        strokeWidth={isExplicit ? 2 : 1.5}
        strokeDasharray={isExplicit ? undefined : '5 5'}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={isExplicit ? 'url(#tf-arrow-explicit)' : 'url(#tf-arrow-implicit)'}
        className="react-flow__edge-path"
        style={{
          transition: 'stroke 200ms',
          ...(isExplicit ? {} : { animation: 'tf-dash-flow 1.5s linear infinite' }),
        }}
      />
      {/* Animated flow dot along explicit edges */}
      {isExplicit && (
        <circle r="2.5" fill="var(--accent-fg)" opacity="0.7">
          <animateMotion dur="2.5s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {/* Hover label */}
      {outputs && hovered && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transform',
              'rounded-md border border-border/50 bg-surface/95 backdrop-blur-sm',
              'px-2.5 py-1 font-mono text-[10px] leading-tight text-fg-muted shadow-lg',
              'max-w-[280px] truncate',
              'animate-fade-in'
            )}
            style={{ left: labelX, top: labelY, zIndex: 10 }}
            title={outputs}
          >
            <span className="mr-1 text-accent/60">&rarr;</span>
            {outputs}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const TerraformDependencyEdge = memo(TerraformDependencyEdgeComponent);
TerraformDependencyEdge.displayName = 'TerraformDependencyEdge';
