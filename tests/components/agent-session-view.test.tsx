import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionView } from '@/app/components/features/agent-session-view';

const leaveMock = vi.fn();

vi.mock('@/app/hooks/use-session', () => ({
  useSession: () => ({
    state: {
      chunks: [{ text: 'hello', timestamp: 1_700_000_000_000 }],
      toolCalls: [],
      terminal: [],
      presence: [],
      agentState: { status: 'running' },
    },
    connectionState: 'connected',
    leave: leaveMock,
  }),
}));

vi.mock('@/app/hooks/use-presence', () => ({
  usePresence: () => ({ users: [] }),
}));

describe('AgentSessionView', () => {
  it('renders the reconnect-aware stream view from the shared import path', async () => {
    render(
      <AgentSessionView
        sessionId="session-1"
        agentId="agent-1"
        userId="user-1"
        onPause={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
        onStop={vi.fn(async () => {})}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Agent Stream')).toBeInTheDocument();
    });

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByTestId('session-output')).toBeInTheDocument();
  });
});
