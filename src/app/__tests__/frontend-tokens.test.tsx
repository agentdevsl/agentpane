/**
 * arch29-W3-C / F08-01 + F08-02 — frontend design-token regression tests.
 *
 * Locks in two contracts that the April 29 review found broken:
 *
 *   1. F08-01 — no Tailwind `*-warning` class survives in the rendered DOM.
 *      The design system uses `attention` not `warning` (CLAUDE.md). Tailwind
 *      v4 emits the literal class with no rule when a token is missing, so
 *      `bg-warning`, `text-warning`, etc. render as silent no-ops.
 *
 *   2. F08-02 — no hardcoded SVG hex literal (`fill="#..."`, `stroke="#..."`,
 *      `stopColor="#..."`, `floodColor="#..."`) survives in the rendered SVG
 *      output of theme-bound components. CSS custom properties (e.g.
 *      `var(--accent-fg)`) must be used so the colour adapts to light/dark.
 *
 * The mascot eyes in `AIActionButton` are intentionally allow-listed (fixed
 * dark-grey to preserve the mascot's silhouette across themes) and the test
 * for that component asserts that the *only* hex literals are the eyes.
 */
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentEdgeMarkers } from '@/app/components/features/agent-topology/edges/agent-edge-markers';
import { TerraformEdgeMarkers } from '@/app/components/features/terraform/terraform-dependency-edge';
import { AgentPaneLogo } from '@/app/components/ui/agentpane-logo';
import { AIActionButton } from '@/app/components/ui/ai-action-button';

const HEX_LITERAL_RE = /#[0-9A-Fa-f]{3,8}\b/g;
const TAILWIND_WARNING_RE =
  /\b(?:bg|text|border|ring|fill|stroke|via|from|to)-warning(?:-(?:muted|emphasis|subtle|fg|hover))?(?:\/\d+)?\b/;

describe('F08-01: Tailwind warning tokens are gone', () => {
  it('AgentPaneLogo emits no `*-warning` Tailwind classes', () => {
    const { container } = render(<AgentPaneLogo />);
    expect(container.outerHTML).not.toMatch(TAILWIND_WARNING_RE);
  });

  it('AIActionButton emits no `*-warning` Tailwind classes', () => {
    const { container } = render(<AIActionButton>Test</AIActionButton>);
    expect(container.outerHTML).not.toMatch(TAILWIND_WARNING_RE);
  });
});

describe('F08-02: SVG hex literals are gone', () => {
  it('AgentPaneLogo SVG carries no hex literals — all colours use CSS vars', () => {
    const { container } = render(<AgentPaneLogo />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const html = svg?.outerHTML ?? '';
    // Strip the rgba() literals from drop-shadow filters (they are inline
    // style attributes carrying decorative shadow colours, not theme
    // colours). Then assert no remaining hex literals.
    const stripped = html.replace(/rgba\([^)]+\)/g, '');
    const hits = stripped.match(HEX_LITERAL_RE) ?? [];
    expect(hits, `unexpected hex literals: ${hits.join(', ')}`).toEqual([]);
  });

  it('AgentEdgeMarkers SVG carries no hex literals', () => {
    const { container } = render(<AgentEdgeMarkers />);
    const html = container.querySelector('svg')?.outerHTML ?? '';
    const hits = html.match(HEX_LITERAL_RE) ?? [];
    expect(hits, `unexpected hex literals: ${hits.join(', ')}`).toEqual([]);
  });

  it('TerraformEdgeMarkers SVG carries no hex literals', () => {
    const { container } = render(<TerraformEdgeMarkers />);
    const html = container.querySelector('svg')?.outerHTML ?? '';
    const hits = html.match(HEX_LITERAL_RE) ?? [];
    expect(hits, `unexpected hex literals: ${hits.join(', ')}`).toEqual([]);
  });

  it('AIActionButton SVG carries only the allow-listed mascot eyes (#1a1a1a)', () => {
    const { container } = render(<AIActionButton>Test</AIActionButton>);
    const svgs = Array.from(container.querySelectorAll('svg')) as SVGSVGElement[];
    const html = svgs.map((s) => s.outerHTML).join('');
    const hits = html.match(HEX_LITERAL_RE) ?? [];
    // The mascot's eyes are intentionally fixed to preserve the silhouette
    // across themes. They are the ONLY hex literals we accept here.
    const allowed = new Set(['#1a1a1a']);
    const disallowed = hits.filter((h) => !allowed.has(h.toLowerCase()));
    expect(disallowed, `unexpected hex literals: ${disallowed.join(', ')}`).toEqual([]);
  });
});
