import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalDialog } from '@/app/components/features/approval-dialog';
import type { Task } from '@/db/schema';

const createTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'task-1',
  codespaceId: overrides.codespaceId ?? 'project-1',
  title: overrides.title ?? 'Review task',
  description: overrides.description ?? null,
  column: overrides.column ?? 'waiting_approval',
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

describe('ApprovalDialog', () => {
  it('renders task title and action buttons', () => {
    render(
      <ApprovalDialog
        task={createTask({ title: 'Ship it' })}
        diff={null}
        open
        onOpenChange={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );

    expect(screen.getByText('Ship it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve & merge/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('calls onApprove', () => {
    const onApprove = vi.fn();
    render(
      <ApprovalDialog
        task={createTask({ title: 'Approve task' })}
        diff={null}
        open
        onOpenChange={vi.fn()}
        onApprove={onApprove}
        onReject={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /approve & merge/i }));
    expect(onApprove).toHaveBeenCalled();
  });
});
