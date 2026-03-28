import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ActiveAgent,
  AddProjectCard,
  formatRelativeTime,
  getInitials,
  ProjectCard,
  type ProjectCardProps,
  type TaskCounts,
} from '@/app/components/features/project-card';
import { TooltipProvider } from '@/app/components/ui/tooltip';

function renderCard(props: ProjectCardProps) {
  return render(
    <TooltipProvider>
      <ProjectCard {...props} />
    </TooltipProvider>
  );
}

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={to} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

const mockProject = {
  id: 'proj-123',
  name: 'Test Project',
  path: '/path/to/project',
  config: {},
  maxConcurrentAgents: 3,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  configPath: null,
  githubOwner: null,
  githubRepo: null,
  githubInstallationId: null,
};

const defaultTaskCounts: TaskCounts = {
  backlog: 5,
  queued: 0,
  inProgress: 3,
  waitingApproval: 2,
  verified: 10,
  total: 20,
};

const defaultProps: ProjectCardProps = {
  project: mockProject,
  status: 'idle',
  taskCounts: defaultTaskCounts,
  activeAgents: [],
};

describe('getInitials', () => {
  it('returns initials for single word', () => {
    expect(getInitials('Project')).toBe('P');
  });

  it('returns initials for two words', () => {
    expect(getInitials('Test Project')).toBe('TP');
  });

  it('returns initials for more than two words', () => {
    expect(getInitials('My Test Project Name')).toBe('MT');
  });

  it('handles extra spaces between words', () => {
    expect(getInitials('Test  Project')).toBe('TP');
  });

  it('handles leading and trailing spaces', () => {
    expect(getInitials('  Test Project  ')).toBe('TP');
  });

  it('handles empty string', () => {
    expect(getInitials('')).toBe('');
  });

  it('handles string with only spaces', () => {
    expect(getInitials('   ')).toBe('');
  });

  it('converts to uppercase', () => {
    expect(getInitials('test project')).toBe('TP');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for time less than a minute ago', () => {
    const date = new Date('2024-01-15T11:59:30Z');
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns minutes ago for time less than an hour ago', () => {
    const date = new Date('2024-01-15T11:45:00Z');
    expect(formatRelativeTime(date)).toBe('15m ago');
  });

  it('returns hours ago for time less than a day ago', () => {
    const date = new Date('2024-01-15T08:00:00Z');
    expect(formatRelativeTime(date)).toBe('4h ago');
  });

  it('returns days ago for time more than a day ago', () => {
    const date = new Date('2024-01-12T12:00:00Z');
    expect(formatRelativeTime(date)).toBe('3d ago');
  });

  it('returns 1d ago for exactly 25 hours ago', () => {
    const date = new Date('2024-01-14T11:00:00Z');
    expect(formatRelativeTime(date)).toBe('1d ago');
  });
});

describe('ProjectCard', () => {
  describe('rendering', () => {
    it('renders project name', () => {
      renderCard(defaultProps);
      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });

    it('renders project path', () => {
      renderCard(defaultProps);
      expect(screen.getByText('/path/to/project')).toBeInTheDocument();
    });

    it('renders project initials in avatar', () => {
      renderCard(defaultProps);
      expect(screen.getByText('TP')).toBeInTheDocument();
    });

    it('renders Open button for idle status', () => {
      renderCard({ ...defaultProps, status: 'idle' });
      expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument();
    });

    it('renders Review button for needs-approval status', () => {
      renderCard({ ...defaultProps, status: 'needs-approval' });
      expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    });
  });

  describe('status variations', () => {
    it('displays Running status badge', () => {
      renderCard({ ...defaultProps, status: 'running' });
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('displays Idle status badge', () => {
      renderCard({ ...defaultProps, status: 'idle' });
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });

    it('displays Needs Approval status badge', () => {
      renderCard({ ...defaultProps, status: 'needs-approval' });
      expect(screen.getByText('Needs Approval')).toBeInTheDocument();
    });
  });

  describe('MiniKanbanBar', () => {
    it('renders all five column icons with counts', () => {
      renderCard(defaultProps);
      // Each MiniKanbanBar renders an icon and a count
      // Verify all five counts are present (5 backlog, 0 queued, 3 inProgress, 2 approval, 10 done)
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });

    it('renders correct counts', () => {
      renderCard(defaultProps);
      expect(screen.getByText('5')).toBeInTheDocument(); // backlog
      expect(screen.getByText('3')).toBeInTheDocument(); // inProgress
      expect(screen.getByText('2')).toBeInTheDocument(); // waitingApproval
      expect(screen.getByText('10')).toBeInTheDocument(); // verified
    });

    it('handles zero total correctly', () => {
      const zeroTaskCounts: TaskCounts = {
        backlog: 0,
        queued: 0,
        inProgress: 0,
        waitingApproval: 0,
        verified: 0,
        total: 0,
      };
      renderCard({ ...defaultProps, taskCounts: zeroTaskCounts });
      // Should render without errors (all counts show 0)
      expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('agent activity section', () => {
    it('displays "No agents currently running" when no active agents', () => {
      renderCard({ ...defaultProps, activeAgents: [] });
      expect(screen.getByText('No agents currently running')).toBeInTheDocument();
    });

    it('displays running agents count', () => {
      const activeAgents: ActiveAgent[] = [
        { id: 'agent-1', name: 'Agent 1', taskId: 'task-1', taskTitle: 'Task 1', type: 'runner' },
        { id: 'agent-2', name: 'Agent 2', taskId: 'task-2', taskTitle: 'Task 2', type: 'runner' },
      ];
      renderCard({ ...defaultProps, status: 'running', activeAgents });
      expect(screen.getByText('2 running')).toBeInTheDocument();
    });

    it('displays agent names', () => {
      const activeAgents: ActiveAgent[] = [
        { id: 'agent-1', name: 'My Agent', taskId: 'task-1', taskTitle: 'Task 1', type: 'runner' },
      ];
      renderCard({ ...defaultProps, status: 'running', activeAgents });
      expect(screen.getByText('My Agent')).toBeInTheDocument();
    });

    it('displays pending review message for needs-approval status', () => {
      renderCard({ ...defaultProps, status: 'needs-approval' });
      expect(screen.getByText('Pending Review')).toBeInTheDocument();
    });

    it('displays tasks awaiting approval count', () => {
      renderCard({ ...defaultProps, status: 'needs-approval' });
      // Verify the full message is present with correct count
      const text = screen.getByText(/awaiting approval/);
      expect(text).toBeInTheDocument();
      expect(text.textContent).toContain('#2');
    });
  });

  describe('footer', () => {
    it('renders success rate when provided', () => {
      renderCard({ ...defaultProps, successRate: 85.5 });
      expect(screen.getByText('85.5% success')).toBeInTheDocument();
    });

    it('renders last run time when provided', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));

      const lastRunAt = new Date('2024-01-15T10:00:00Z');
      renderCard({ ...defaultProps, lastRunAt });
      expect(screen.getByText('Last run 2h ago')).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('renders "No recent activity" when no success rate, last run, or active agents', () => {
      renderCard({ ...defaultProps, activeAgents: [] });
      expect(screen.getByText('No recent activity')).toBeInTheDocument();
    });

    it('links to project page', () => {
      renderCard(defaultProps);
      const link = screen.getByRole('link', { name: 'Open' });
      expect(link).toHaveAttribute('href', '/codespaces/$codespaceId');
      expect(link).toHaveAttribute('data-params', JSON.stringify({ codespaceId: 'proj-123' }));
    });
  });
});

describe('AddProjectCard', () => {
  it('renders add project button', () => {
    const onClick = vi.fn();
    render(<AddProjectCard onClick={onClick} />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders add project text', () => {
    const onClick = vi.fn();
    render(<AddProjectCard onClick={onClick} />);
    expect(screen.getByText('Add New Codespace')).toBeInTheDocument();
    expect(screen.getByText('Import or create a codespace')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<AddProjectCard onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders accessible icon title', () => {
    const onClick = vi.fn();
    render(<AddProjectCard onClick={onClick} />);
    expect(screen.getByTitle('Add new codespace')).toBeInTheDocument();
  });
});
