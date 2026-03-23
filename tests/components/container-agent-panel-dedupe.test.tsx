import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerAgentPanel } from '@/app/components/features/container-agent-panel';
import type { SessionCallbacks } from '@/lib/streams/client';

let latestCallbacks: SessionCallbacks | null = null;

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
        getLastCursor: () => null,
        getLastOffset: () => 0,
      };
    }),
  };
});

vi.mock('@/app/components/features/agent-topology', () => ({
  AgentTopology: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="mock-topology">{sessionId ?? 'no-session'}</div>
  ),
}));

describe('ContainerAgentPanel topology replay dedupe', () => {
  beforeEach(() => {
    latestCallbacks = null;
  });

  it('keeps a single topology root node when container-agent started replays with the same stable identity', async () => {
    const user = userEvent.setup();

    render(<ContainerAgentPanel sessionId="session-1" />);

    await user.click(screen.getByRole('button', { name: 'Topology' }));

    act(() => {
      latestCallbacks?.onContainerAgentStarted?.({
        channel: 'containerAgent:started',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          model: 'gpt-5.4',
          maxTurns: 12,
          timestamp: 1,
        },
        cursor: 'cursor-started-1',
        meta: { eventId: 'evt-started-1' },
      } as never);
      latestCallbacks?.onContainerAgentStarted?.({
        channel: 'containerAgent:started',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          model: 'gpt-5.4',
          maxTurns: 12,
          timestamp: 1,
        },
        cursor: 'cursor-started-1',
        meta: { eventId: 'evt-started-1' },
      } as never);
    });

    expect(screen.getByTestId('mock-topology')).toBeInTheDocument();
  });
});
