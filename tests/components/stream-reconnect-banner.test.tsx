/**
 * F05-15: StreamReconnectBanner component.
 *
 * Verifies the banner renders a reconnect button, fires the callback, and
 * disables itself while loading.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StreamReconnectBanner } from '../../src/app/components/ui/stream-reconnect-banner.js';

describe('StreamReconnectBanner (F05-15)', () => {
  it('renders an alert with the reconnect button', () => {
    const onReconnect = vi.fn();
    render(<StreamReconnectBanner onReconnect={onReconnect} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/disconnected from live updates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('invokes onReconnect when the button is clicked', () => {
    const onReconnect = vi.fn();
    render(<StreamReconnectBanner onReconnect={onReconnect} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('disables the button while loading', () => {
    const onReconnect = vi.fn();
    render(<StreamReconnectBanner onReconnect={onReconnect} loading />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/reconnect/i);
  });
});
