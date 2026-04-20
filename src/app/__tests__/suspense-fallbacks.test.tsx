/**
 * F08-01 seed tests for the shared Suspense fallbacks.
 *
 * Verifies that the shared fallback replacements for the old `fallback={null}`
 * sites render an accessible `role="status"` / `aria-busy="true"` region so
 * screen readers announce that content is loading, and that the visible panel
 * variant renders a skeleton scaffold (not an empty shell).
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DialogLoadingFallback,
  PanelLoadingFallback,
} from '@/app/components/ui/suspense-fallbacks';

describe('DialogLoadingFallback', () => {
  it('renders an accessible status region that is visually hidden', () => {
    render(<DialogLoadingFallback />);
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'true');
    // Visually hidden, but present in the accessibility tree.
    expect(region).toHaveClass('sr-only');
  });

  it('supports a custom label for the SR announcement', () => {
    render(<DialogLoadingFallback label="Loading new task dialog…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading new task dialog…');
  });
});

describe('PanelLoadingFallback', () => {
  it('renders a skeleton scaffold inside a role=status region', () => {
    render(<PanelLoadingFallback />);
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'true');
    // The skeleton scaffold should produce at least one skeleton element.
    expect(screen.getAllByTestId('skeleton-card').length).toBeGreaterThan(0);
  });
});
