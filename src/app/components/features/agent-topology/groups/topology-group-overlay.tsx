/**
 * Renders translucent rounded-rectangle backgrounds behind clusters of
 * sibling subagents that share the same `agent_type`. Sits inside the
 * ReactFlow viewport so it pans + zooms with the rest of the canvas.
 *
 * Phase 2 of the topology-visual-polish branch: now that we capture real
 * subagent types from the SDK (e.g. `tf-module-research`,
 * `tf-module-design`), the visual grouping makes the workflow stage
 * obvious at a glance — five research nodes in one box, design in
 * another — without requiring users to read every label.
 */

import { type ReactFlowState, useStore } from '@xyflow/react';
import { useMemo } from 'react';
import type { TopologyGroupBox } from '../topology-layout';

interface TopologyGroupOverlayProps {
  groups: TopologyGroupBox[];
}

/**
 * Stable colour-from-string hash. Maps an `agent_type` to a hue so each
 * cluster gets a distinct, readable tint without us hand-curating a
 * palette per subagent name. Avoids the obvious failure mode where two
 * clusters land on the exact same background colour.
 */
function tintForAgentType(agentType: string): { fill: string; stroke: string; label: string } {
  let hash = 0;
  for (let i = 0; i < agentType.length; i++) {
    hash = (hash * 31 + agentType.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    fill: `hsl(${hue}, 60%, 55%, 0.06)`,
    stroke: `hsl(${hue}, 60%, 60%, 0.45)`,
    label: `hsl(${hue}, 60%, 75%)`,
  };
}

const transformSelector = (s: ReactFlowState) =>
  `translate(${s.transform[0]}px, ${s.transform[1]}px) scale(${s.transform[2]})`;

export function TopologyGroupOverlay({
  groups,
}: TopologyGroupOverlayProps): React.JSX.Element | null {
  // Read the viewport transform so the overlay tracks pan/zoom in lockstep
  // with the rest of the ReactFlow canvas. Selecting just the transform
  // avoids re-rendering on every node-position tick.
  const transform = useStore(transformSelector);

  const boxes = useMemo(
    () => groups.map((g) => ({ ...g, ...tintForAgentType(g.agentType) })),
    [groups]
  );

  if (boxes.length === 0) return null;

  return (
    <div
      // Sit just above the ReactFlow background grid but below the
      // node/edge layers so groups read as backdrops, not foreground UI.
      // Layer numbers come from ReactFlow's internal stacking: nodes are
      // at z-index 4, edges at 1; we use 0 to slot under both.
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        transform,
        transformOrigin: '0 0',
        zIndex: 0,
      }}
    >
      {boxes.map((g) => (
        <div
          key={g.id}
          style={{
            position: 'absolute',
            left: g.x,
            top: g.y,
            width: g.width,
            height: g.height,
            borderRadius: 18,
            backgroundColor: g.fill,
            border: `1px dashed ${g.stroke}`,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 6,
              left: 12,
              // Single-cluster boxes (one node) are only ~200px wide; long
              // type names like `tf-module-validator` plus the count
              // suffix used to wrap onto two lines and visually leave the
              // box. nowrap lets the label overflow horizontally instead
              // of wrapping; the cluster type is still readable on hover
              // via the title tooltip even if it does extend past the
              // node circle.
              whiteSpace: 'nowrap',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: g.label,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            }}
            title={`${g.agentType} (${g.nodeCount} ${g.nodeCount === 1 ? 'agent' : 'agents'})`}
          >
            {g.agentType}
            <span
              style={{
                marginLeft: 6,
                opacity: 0.6,
                fontWeight: 400,
              }}
            >
              ×{g.nodeCount}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
