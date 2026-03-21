import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { type RawSession, SessionHistory } from '@/app/components/features/session-history';

// Mock the API client
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    sessions: {
      get: vi.fn(),
      getEvents: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getSummary: vi.fn().mockResolvedValue({ ok: true, data: null }),
      export: vi.fn(),
    },
  },
}));

describe('SessionHistory', () => {
  const mockSessions: RawSession[] = [
    {
      id: 'session-1',
      codespaceId: 'project-1',
      taskId: null, // No taskId so title will show
      agentId: 'agent-1',
      title: 'Daily sync',
      url: 'http://example.com/session-1',
      status: 'active',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'session-2',
      codespaceId: 'project-1',
      taskId: 'task-2', // Has taskId, title won't show
      agentId: null,
      title: 'Code review',
      url: 'http://example.com/session-2',
      status: 'paused',
      createdAt: new Date().toISOString(),
    },
  ];

  it('renders sessions in the timeline', () => {
    render(<SessionHistory sessions={mockSessions} />);

    // Component shows "Recent Sessions" header
    expect(screen.getByText('Recent Sessions')).toBeInTheDocument();
    // Shows session count
    expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
  });

  it('renders session titles when no taskId is present', () => {
    render(<SessionHistory sessions={mockSessions} />);

    // Session without taskId should show its title
    expect(screen.getByText('Daily sync')).toBeInTheDocument();
  });

  it('renders session cards', () => {
    render(<SessionHistory sessions={mockSessions} />);

    // Should render session cards with IDs
    const sessionCards = screen.getAllByTestId('session-card');
    expect(sessionCards).toHaveLength(2);
  });

  it('renders empty state when no sessions', () => {
    render(<SessionHistory sessions={[]} />);

    expect(screen.getByText('No sessions found')).toBeInTheDocument();
  });

  it('allows selecting a session', async () => {
    const user = userEvent.setup();

    render(<SessionHistory sessions={mockSessions} />);

    // Find and click a session card
    const sessionCards = screen.getAllByTestId('session-card');
    await user.click(sessionCards[0]!);

    // After clicking, the card should be selected (aria-pressed)
    await waitFor(() => {
      expect(sessionCards[0]).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('shows project filter when projects are provided', () => {
    const projects = [
      { id: 'project-1', name: 'Test Project' },
      { id: 'project-2', name: 'Another Project' },
    ];

    render(
      <SessionHistory sessions={mockSessions} projects={projects} onProjectChange={vi.fn()} />
    );

    // Should show project filter input
    expect(screen.getByPlaceholderText('All projects')).toBeInTheDocument();
  });
});
