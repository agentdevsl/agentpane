/**
 * F09-02 seed test: ErrorBoundary recovery.
 *
 * Renders a component that throws, asserts the fallback UI is shown, clicks
 * "Retry", and asserts the boundary re-renders its children successfully on
 * the next render. Mirrors the pattern used in `agent-topology/index.tsx`
 * and `memory-view/memory-view.tsx`, now centralised in
 * `src/app/components/ui/error-boundary.tsx`.
 *
 * See `specs/arch_review_april/09-testing.md` F09-02.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/app/components/ui/error-boundary';

function Exploder({ shouldThrow }: { shouldThrow: boolean }): React.JSX.Element {
  if (shouldThrow) {
    throw new Error('Kaboom!');
  }
  return <div data-testid="exploder-ok">exploder rendered ok</div>;
}

describe('ErrorBoundary', () => {
  // React logs caught errors to console.error during tests; silence them.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // suppress
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Exploder shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('exploder-ok')).toBeInTheDocument();
  });

  it('renders the default fallback with a Retry button when a child throws', () => {
    render(
      <ErrorBoundary label="Topology">
        <Exploder shouldThrow />
      </ErrorBoundary>
    );

    // Default fallback surfaces the error message and a role="alert" wrapper.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Topology failed to load/i)).toBeInTheDocument();
    expect(screen.getByText(/Kaboom!/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('clicking Retry clears the error and re-renders children', () => {
    // Parent owns the `shouldThrow` flag so we can flip it between renders,
    // simulating "the underlying cause has been fixed" (e.g. stream reconnected).
    function Harness(): React.JSX.Element {
      const [broken, setBroken] = useState(true);
      return (
        <>
          <button type="button" data-testid="fix" onClick={() => setBroken(false)}>
            fix
          </button>
          <ErrorBoundary label="Topology">
            <Exploder shouldThrow={broken} />
          </ErrorBoundary>
        </>
      );
    }

    render(<Harness />);

    // 1. Fallback is shown.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // 2. Fix the underlying cause, then click Retry.
    fireEvent.click(screen.getByTestId('fix'));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    // 3. Children render again, fallback is gone.
    expect(screen.getByTestId('exploder-ok')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invokes the onError hook with the caught error', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary label="Topology" onError={onError}>
        <Exploder shouldThrow />
      </ErrorBoundary>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [err] = onError.mock.calls[0] ?? [];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Kaboom!');
  });

  it('supports a custom render-prop fallback with a reset callback', () => {
    render(
      <ErrorBoundary
        fallback={(err, reset) => (
          <div>
            <p data-testid="custom-msg">custom: {err.message}</p>
            <button type="button" onClick={reset}>
              custom retry
            </button>
          </div>
        )}
      >
        <Exploder shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-msg')).toHaveTextContent('custom: Kaboom!');
    // The reset button is wired — clicking it won't crash, and because the
    // child still throws, the boundary catches again (verifies reset path
    // works without leaving the boundary in a stuck state).
    fireEvent.click(screen.getByRole('button', { name: /custom retry/i }));
    expect(screen.getByTestId('custom-msg')).toBeInTheDocument();
  });
});
