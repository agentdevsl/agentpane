import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '@/app/components/features/kanban-board';
import type { Task } from '@/db/schema';

const createTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'task-1',
  codespaceId: overrides.codespaceId ?? 'project-1',
  title: overrides.title ?? 'Task title',
  description: overrides.description ?? null,
  column: overrides.column ?? 'backlog',
  position: overrides.position ?? 0,
  labels: overrides.labels ?? [],
  branch: null,
  diffSummary: null,
  approvedAt: null,
  approvedBy: null,
  rejectionCount: 0,
  rejectionReason: null,
  agentId: null,
  sessionId: null,
  worktreeId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: null,
  completedAt: null,
});

describe('KanbanBoard', () => {
  it('renders all columns', () => {
    render(<KanbanBoard tasks={[]} onTaskMove={vi.fn()} onTaskClick={vi.fn()} isLoading={false} />);

    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Waiting Approval')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('renders tasks by column', () => {
    const tasks = [
      createTask({ id: 't1', title: 'Task 1', column: 'backlog' }),
      createTask({ id: 't2', title: 'Task 2', column: 'in_progress' }),
    ];

    render(
      <KanbanBoard tasks={tasks} onTaskMove={vi.fn()} onTaskClick={vi.fn()} isLoading={false} />
    );

    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
  });

  it('calls onTaskClick when card clicked', () => {
    const tasks = [createTask({ id: 't1', title: 'Click me' })];
    const onTaskClick = vi.fn();

    render(
      <KanbanBoard tasks={tasks} onTaskMove={vi.fn()} onTaskClick={onTaskClick} isLoading={false} />
    );

    fireEvent.click(screen.getByText('Click me'));
    expect(onTaskClick).toHaveBeenCalledWith(tasks[0]);
  });
});
