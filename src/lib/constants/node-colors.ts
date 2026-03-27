import type { NodeType } from '@/lib/workflow-dsl/types';

/**
 * Node colors from design-tokens.css
 * Single source of truth for workflow node styling across all components.
 */

// Shared color config for logic node types (conditional, loop, parallel)
const LOGIC_NODE_COLOR = {
  fill: '#a371f7', // --done-fg
  fillMuted: 'rgba(163, 113, 247, 0.15)',
  stroke: 'rgba(163, 113, 247, 0.35)',
  text: '#a371f7',
  // CSS variable references for Tailwind classes
  bgClass: 'bg-[var(--done-muted)]',
  textClass: 'text-[var(--done-fg)]',
} as const;

/**
 * Full color configuration for each node type.
 * Includes both raw hex values (for SVG) and CSS variable classes (for Tailwind).
 */
export const NODE_COLORS: Record<
  NodeType,
  {
    fill: string;
    fillMuted: string;
    stroke: string;
    text: string;
    bgClass: string;
    textClass: string;
  }
> = {
  start: {
    fill: '#3fb950', // --success-fg
    fillMuted: 'rgba(63, 185, 80, 0.12)',
    stroke: 'rgba(63, 185, 80, 0.35)',
    text: '#0d1117',
    bgClass: 'bg-[var(--success-muted)]',
    textClass: 'text-[var(--success-fg)]',
  },
  end: {
    fill: '#f85149', // --danger-fg
    fillMuted: 'rgba(248, 81, 73, 0.12)',
    stroke: 'rgba(248, 81, 73, 0.35)',
    text: '#0d1117',
    bgClass: 'bg-[var(--danger-muted)]',
    textClass: 'text-[var(--danger-fg)]',
  },
  skill: {
    fill: '#f778ba', // --secondary-fg
    fillMuted: 'rgba(247, 120, 186, 0.15)',
    stroke: 'rgba(247, 120, 186, 0.35)',
    text: '#f778ba',
    bgClass: 'bg-[var(--secondary-muted)]',
    textClass: 'text-[var(--secondary-fg)]',
  },
  context: {
    fill: '#d29922', // --attention-fg
    fillMuted: 'rgba(210, 153, 34, 0.15)',
    stroke: 'rgba(210, 153, 34, 0.35)',
    text: '#d29922',
    bgClass: 'bg-[var(--attention-muted)]',
    textClass: 'text-[var(--attention-fg)]',
  },
  agent: {
    fill: '#58a6ff', // --accent-fg
    fillMuted: 'rgba(88, 166, 255, 0.15)',
    stroke: 'rgba(88, 166, 255, 0.35)',
    text: '#58a6ff',
    bgClass: 'bg-[var(--accent-muted)]',
    textClass: 'text-[var(--accent-fg)]',
  },
  conditional: LOGIC_NODE_COLOR,
  loop: LOGIC_NODE_COLOR,
  parallel: LOGIC_NODE_COLOR,
};

/**
 * Default fallback colors for unknown node types
 */
export const DEFAULT_NODE_COLOR = {
  fill: '#8b949e',
  fillMuted: 'rgba(139, 148, 158, 0.15)',
  stroke: 'rgba(139, 148, 158, 0.35)',
  text: '#8b949e',
  bgClass: 'bg-[var(--bg-muted)]',
  textClass: 'text-[var(--fg-muted)]',
} as const;

/**
 * Get node colors with fallback for unknown types
 */
export function getNodeColors(nodeType: string): (typeof NODE_COLORS)[NodeType] {
  return NODE_COLORS[nodeType as NodeType] ?? DEFAULT_NODE_COLOR;
}
