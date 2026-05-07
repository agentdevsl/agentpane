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
 * Each tint resolves to a CSS custom property at render time, so the
 * cluster boxes track the active theme (light / dark / system) without
 * any per-theme branching here. `color-mix(in srgb, var(--x) N%,
 * transparent)` is the same pattern globals.css already uses for diff
 * colour gutters — we just lean on it instead of hand-rolling RGBA.
 *
 * Anything that doesn't match a phase keyword falls back to the
 * stable HSL string-hash, so adding a new agent_type still yields a
 * readable colour without code changes.
 */
type ClusterTint = { fill: string; stroke: string; label: string };

/**
 * Build a tint triple from a single design-token variable. The fill +
 * stroke percentages are tuned so cluster outlines read clearly on both
 * the dark canvas (where 8% washed out) and the light canvas. The label
 * is solid for legibility.
 */
function tintFromToken(varName: string): ClusterTint {
  return {
    fill: `color-mix(in srgb, var(${varName}) 22%, transparent)`,
    stroke: `var(${varName})`,
    label: `var(${varName})`,
  };
}

const PHASE_TINTS = {
  // research → accent (blue)
  research: tintFromToken('--accent-fg'),
  // design → done (purple)
  design: tintFromToken('--done-fg'),
  // test / validator / qa → attention (amber)
  test: tintFromToken('--attention-fg'),
  // local bash / shell tooling → muted neutral so it doesn't compete
  // visually with the workflow stages
  bash: tintFromToken('--fg-muted'),
  // developer / implementer → success (green)
  develop: tintFromToken('--success-fg'),
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
 * Same algorithm as before — adding a new subagent name still produces
 * a readable, deterministic colour without a code change.
 *
 * The label colour uses `color-mix` against the theme's foreground
 * token so it inherits the right contrast in either mode: in dark mode
 * the chroma sits at ~62% lightness against a near-black canvas; in
 * light mode color-mix darkens the same hue against the dark `--fg-default`
 * token (`#1f2328`-ish), keeping the label readable on a white canvas.
 * Without this, the previous 78%-lightness label washed out completely
 * on light themes.
 */
function fallbackTint(agentType: string): ClusterTint {
  let hash = 0;
  for (let i = 0; i < agentType.length; i++) {
    hash = (hash * 31 + agentType.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  // The chroma colour itself doesn't change between themes — only how
  // we mix it. The label is mixed 70% chroma + 30% foreground so it
  // gets pulled toward whichever foreground the theme defines (white
  // on dark, near-black on light).
  const chroma = `hsl(${hue}, 62%, 55%)`;
  return {
    fill: `color-mix(in srgb, ${chroma} 22%, transparent)`,
    stroke: chroma,
    label: `color-mix(in srgb, ${chroma} 70%, var(--fg-default))`,
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
            border: `1.5px solid ${g.stroke}`,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 6,
              left: 12,
              right: 12,
              // Clip overlong type names with an ellipsis so the label
              // can never spill past the cluster outline. The full name
              // remains discoverable via the title tooltip below.
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: 0.7,
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
