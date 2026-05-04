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
 * Tint palette for cluster boxes. The hue carries meaning: workflow
 * phase (research / design / test / develop) instead of "whatever the
 * string-hash spat out for this agent_type." A small set of distinct,
 * recognisable hues from the rest of the app's palette so the eye
 * groups by phase, not by a coincidence of `agent_type` characters.
 *
 * Anything that doesn't match a phase keyword falls back to the
 * stable HSL string-hash, so adding a new agent_type still yields a
 * readable colour without code changes.
 */
type ClusterTint = { fill: string; stroke: string; label: string };

const PHASE_TINTS = {
  // research → accent (blue)
  research: {
    fill: 'rgba(47, 129, 247, 0.08)',
    stroke: 'rgba(47, 129, 247, 0.55)',
    label: 'rgba(120, 170, 255, 0.95)',
  },
  // design → done (purple)
  design: {
    fill: 'rgba(163, 113, 247, 0.08)',
    stroke: 'rgba(163, 113, 247, 0.55)',
    label: 'rgba(200, 165, 255, 0.95)',
  },
  // test / validator / qa → attention (amber)
  test: {
    fill: 'rgba(210, 153, 34, 0.08)',
    stroke: 'rgba(210, 153, 34, 0.55)',
    label: 'rgba(240, 195, 100, 0.95)',
  },
  // local bash / shell tooling → muted neutral so it doesn't compete
  // visually with the workflow stages
  bash: {
    fill: 'rgba(110, 118, 129, 0.08)',
    stroke: 'rgba(110, 118, 129, 0.55)',
    label: 'rgba(170, 178, 189, 0.95)',
  },
  // developer / implementer → success (green)
  develop: {
    fill: 'rgba(63, 185, 80, 0.08)',
    stroke: 'rgba(63, 185, 80, 0.55)',
    label: 'rgba(120, 220, 140, 0.95)',
  },
} as const satisfies Record<string, ClusterTint>;

/**
 * Match an `agent_type` string to a phase tint. Substring match because
 * conventional names compose freely: `tf-module-research`,
 * `provider-research`, `module-test-writer`, etc. First match wins;
 * order in the conditional below = priority when keywords overlap.
 */
function matchPhaseTint(agentType: string): ClusterTint | null {
  const t = agentType.toLowerCase();
  if (t.includes('research')) return PHASE_TINTS.research;
  if (t.includes('design')) return PHASE_TINTS.design;
  if (t.includes('test') || t.includes('validator') || t.includes('qa')) return PHASE_TINTS.test;
  if (t.includes('bash') || t.startsWith('local_')) return PHASE_TINTS.bash;
  if (t.includes('develop') || t.includes('implement') || t.includes('builder')) {
    return PHASE_TINTS.develop;
  }
  return null;
}

/**
 * Stable HSL fallback for agent_types not covered by the phase palette.
 * Same algorithm as before — kept so adding a new subagent name still
 * produces a readable, deterministic colour without a code change. The
 * saturation is bumped from 55 → 62 and alpha from 0.06 → 0.08 to
 * match the explicit phase tints above.
 */
function fallbackTint(agentType: string): ClusterTint {
  let hash = 0;
  for (let i = 0; i < agentType.length; i++) {
    hash = (hash * 31 + agentType.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    fill: `hsl(${hue}, 62%, 55%, 0.08)`,
    stroke: `hsl(${hue}, 62%, 60%, 0.55)`,
    label: `hsl(${hue}, 62%, 78%)`,
  };
}

function tintForAgentType(agentType: string): ClusterTint {
  return matchPhaseTint(agentType) ?? fallbackTint(agentType);
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
