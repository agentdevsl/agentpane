import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeManagement } from '@/app/components/features/worktree-management';
import { apiClient } from '@/lib/api/client';

// Mock the API client
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    worktrees: {
      list: vi.fn(),
      getDiff: vi.fn(),
      remove: vi.fn(),
      commit: vi.fn(),
      merge: vi.fn(),
      prune: vi.fn(),
    },
  },
}));

// Mock toast
vi.mock('@/app/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockWorktrees = [
  {
    id: 'worktree-1',
    branch: 'agent/abc123/feature-auth',
    path: '.worktrees/agent-abc123-feature-auth',
    baseBranch: 'main',
    status: 'active',
    taskId: 'task-1',
    taskTitle: 'Implement authentication',
    agentId: 'agent-1',
    agentName: 'TaskBot',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasUncommittedChanges: false,
    aheadBehind: { ahead: 2, behind: 0 },
  },
  {
    id: 'worktree-2',
    branch: 'agent/def456/feature-ui',
    path: '.worktrees/agent-def456-feature-ui',
    baseBranch: 'main',
    status: 'active',
    taskId: 'task-2',
    taskTitle: 'Update UI components',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasUncommittedChanges: true,
  },
];

describe('WorktreeManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.worktrees.list).mockResolvedValue({
      ok: true,
      data: { items: mockWorktrees, totalCount: 2 },
    });
    vi.mocked(apiClient.worktrees.getDiff).mockResolvedValue({
      ok: true,
      data: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    });
    vi.mocked(apiClient.worktrees.remove).mockResolvedValue({
      ok: true,
      data: { success: true },
    });
  });

  it('renders worktree list after loading', async () => {
    render(<WorktreeManagement codespaceId="project-1" />);

    // Initially shows loading
    await waitFor(() => {
      expect(screen.getByText('Worktrees')).toBeInTheDocument();
    });

    // After loading, shows worktrees (text appears multiple times so use getAllByText)
    await waitFor(
      () => {
        expect(screen.getAllByText(/feature-auth/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/feature-ui/).length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );
  });

  it('renders empty state when no worktrees', async () => {
    vi.mocked(apiClient.worktrees.list).mockResolvedValue({
      ok: true,
      data: { items: [], totalCount: 0 },
    });

    render(<WorktreeManagement codespaceId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText('No worktrees yet')).toBeInTheDocument();
    });
  });

  it('shows error state on API failure', async () => {
    vi.mocked(apiClient.worktrees.list).mockResolvedValue({
      ok: false,
      error: { code: 'ERROR', message: 'Failed to fetch worktrees' },
    });

    render(<WorktreeManagement codespaceId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText('Failed to fetch worktrees')).toBeInTheDocument();
    });
  });

  it('renders worktree items with correct structure', async () => {
    render(<WorktreeManagement codespaceId="project-1" />);

    // Wait for worktrees to load
    await waitFor(
      () => {
        expect(screen.getAllByText(/feature-auth/).length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );

    // Verify worktree items are rendered as buttons (clickable for selection)
    const worktreeItems = screen.getAllByRole('button');
    expect(worktreeItems.length).toBeGreaterThan(0);

    // Verify the Refresh button is present
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('shows dirty status for worktrees with uncommitted changes', async () => {
    render(<WorktreeManagement codespaceId="project-1" />);

    await waitFor(() => {
      // Second worktree has uncommitted changes, should show "dirty" status (lowercase)
      expect(screen.getByText('dirty')).toBeInTheDocument();
    });
  });

  it('supports panel mode', async () => {
    render(<WorktreeManagement codespaceId="project-1" panelMode />);

    // Wait for worktrees to load (text appears multiple times so use getAllByText)
    await waitFor(
      () => {
        // In panel mode, should show compact list
        expect(screen.getAllByText(/feature-auth/).length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );
  });
});
