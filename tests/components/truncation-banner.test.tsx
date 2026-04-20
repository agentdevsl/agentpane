/**
 * F05-04: TruncationBanner component + banner rendering.
 *
 * The banner is a simple presentational component; this test verifies:
 *   1. It renders a pluralized message with truncatedCount.
 *   2. The "Load earlier" button fires the onLoadEarlier callback.
 *   3. The button is disabled while loading.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TruncationBanner } from '../../src/app/components/ui/truncation-banner.js';

describe('TruncationBanner (F05-04)', () => {
  it('renders a count and the load-earlier button', () => {
    const onLoad = vi.fn();
    render(<TruncationBanner truncatedCount={1234} onLoadEarlier={onLoad} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/1,234 earlier/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load earlier/i })).toBeInTheDocument();
  });

  it('pluralizes "event was" vs "events were"', () => {
    const { rerender } = render(<TruncationBanner truncatedCount={1} />);
    expect(screen.getByText(/1 earlier event was/)).toBeInTheDocument();
    rerender(<TruncationBanner truncatedCount={3} />);
    expect(screen.getByText(/3 earlier events were/)).toBeInTheDocument();
  });

  it('invokes onLoadEarlier when the button is clicked', () => {
    const onLoad = vi.fn();
    render(<TruncationBanner truncatedCount={10} onLoadEarlier={onLoad} />);
    fireEvent.click(screen.getByRole('button', { name: /load earlier/i }));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('disables the button while loading', () => {
    const onLoad = vi.fn();
    render(<TruncationBanner truncatedCount={10} loading onLoadEarlier={onLoad} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/loading/i);
  });
});
