/**
 * F08-01 seed tests for `ConnectionStatusBanner`.
 *
 * The banner is mounted in `__root.tsx` via `useGlobalConnectionStatus`.
 * These tests lock in the three status renderings so regressions on the
 * global connectivity signal surface in CI.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionStatusBanner } from '@/app/components/ui/connection-status-banner';

describe('ConnectionStatusBanner', () => {
  it('renders nothing when connected', () => {
    const { container } = render(<ConnectionStatusBanner status="connected" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the reconnecting state with a role=alert', () => {
    render(<ConnectionStatusBanner status="reconnecting" />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/reconnecting/i);
  });

  it('renders the disconnected state with a role=alert', () => {
    render(<ConnectionStatusBanner status="disconnected" />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/connection lost/i);
  });
});
