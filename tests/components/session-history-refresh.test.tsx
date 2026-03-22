import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type RawSession, SessionHistory } from '@/app/components/features/session-history';

const getMock = vi.fn();
const getEventsMock = vi.fn();
const getSummaryMock = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    sessions: {
      get: (...args: unknown[]) => getMock(...args),
      getEvents: (...args: unknown[]) => getEventsMock(...args),
      getSummary: (...args: unknown[]) => getSummaryMock(...args),
      export: vi.fn(),
      delete: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } }),
    },
  },
}));

describe('SessionHistory refresh catch-up', () => {
  const session: RawSession = {
    id: 'session-1',
    codespaceId: 'project-1',
    taskId: null,
    agentId: 'agent-1',
    title: 'Daily sync',
    url: 'http://example.com/session-1',
    status: 'active',
    createdAt: new Date('2026-03-23T07:00:00.000Z').toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes selected session detail with afterEventId catch-up and falls back to full reload when anchor is missing', async () => {
    const user = userEvent.setup();

    getMock.mockResolvedValue({ ok: true, data: session });
    getSummaryMock.mockResolvedValue({ ok: true, data: null });

    getEventsMock
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: 'evt-1',
            type: 'container-agent:message',
            timestamp: 100,
            data: { role: 'assistant', content: 'first event' },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: 'evt-2',
            type: 'container-agent:message',
            timestamp: 200,
            data: { role: 'assistant', content: 'second event' },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'SESSION_RESUME_POINT_NOT_FOUND',
          message: 'Session resume point not found',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: 'evt-1',
            type: 'container-agent:message',
            timestamp: 100,
            data: { role: 'assistant', content: 'first event' },
          },
          {
            id: 'evt-2',
            type: 'container-agent:message',
            timestamp: 200,
            data: { role: 'assistant', content: 'second event' },
          },
          {
            id: 'evt-3',
            type: 'container-agent:message',
            timestamp: 300,
            data: { role: 'assistant', content: 'third event' },
          },
        ],
      });

    render(<SessionHistory sessions={[session]} />);

    const sessionCard = await screen.findByTestId('session-card');
    await user.click(sessionCard);

    await screen.findByTestId('tab-session-replay');

    const refreshButton = await screen.findByTitle('Refresh session');
    await user.click(refreshButton);

    await waitFor(() => {
      expect(screen.getByText('second event')).toBeInTheDocument();
    });

    expect(getEventsMock).toHaveBeenNthCalledWith(1, 'session-1', { limit: 1000 });
    expect(getEventsMock).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 1000,
      afterEventId: 'evt-1',
    });

    const refreshedButton = await screen.findByTitle('Refresh session');
    await user.click(refreshedButton);

    await waitFor(() => {
      expect(getEventsMock).toHaveBeenCalledTimes(4);
    });

    expect(getEventsMock).toHaveBeenNthCalledWith(3, 'session-1', {
      limit: 1000,
      afterEventId: 'evt-2',
    });
    expect(getEventsMock).toHaveBeenNthCalledWith(4, 'session-1', { limit: 1000 });

    await user.click(screen.getByTestId('tab-session-replay'));

    await waitFor(() => {
      expect(screen.getByText('third event')).toBeInTheDocument();
    });
  });
});
