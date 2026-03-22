import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerAgentPanel } from '@/app/components/features/container-agent-panel';
import type { SessionCallbacks } from '@/lib/streams/client';

let latestCallbacks: SessionCallbacks | null = null;
let topologyRenderCount = 0;

vi.mock('@/lib/streams/client', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/streams/client')>('@/lib/streams/client');

  return {
    ...actual,
    subscribeToSession: vi.fn((_sessionId: string, callbacks: SessionCallbacks) => {
      latestCallbacks = callbacks;
      return {
        unsubscribe: vi.fn(),
        getState: () => 'connected' as const,
        getLastOffset: () => 0,
      };
    }),
  };
});

vi.mock('@/app/components/features/agent-topology', () => ({
  AgentTopology: ({ sessionId }: { sessionId?: string }) => {
    topologyRenderCount++;
    return <div data-testid="mock-topology">{sessionId ?? 'no-session'}</div>;
  },
}));

function emitToken(index: number): void {
  act(() => {
    latestCallbacks?.onContainerAgentToken?.({
      channel: 'containerAgentToken',
      data: {
        taskId: 'task-1',
        sessionId: 'session-1',
        delta: `${index}`,
        timestamp: index,
      },
      offset: index,
    } as never);
  });
}

describe('ContainerAgentPanel', () => {
  beforeEach(() => {
    latestCallbacks = null;
    topologyRenderCount = 0;
  });

  it('does not rerender topology on token-only stream updates', async () => {
    const user = userEvent.setup();

    render(<ContainerAgentPanel sessionId="session-1" />);

    await user.click(screen.getByRole('button', { name: 'Topology' }));

    expect(screen.getByTestId('mock-topology')).toHaveTextContent('session-1');
    expect(topologyRenderCount).toBe(1);

    emitToken(1);
    emitToken(2);
    emitToken(3);

    expect(topologyRenderCount).toBe(1);
  });
});
