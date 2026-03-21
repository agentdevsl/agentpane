import * as DialogPrimitive from '@radix-ui/react-dialog';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskHeader } from '@/app/components/features/task-detail-dialog/task-header';
import type { Task } from '@/db/schema';

// Wrapper component to provide Dialog context with accessibility elements
function DialogWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content aria-describedby="dialog-description">
          <DialogPrimitive.Title className="sr-only">Test Dialog</DialogPrimitive.Title>
          <DialogPrimitive.Description id="dialog-description" className="sr-only">
            Test dialog description
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// Helper to render within Dialog context
function renderWithDialog(ui: React.ReactElement) {
  return render(<DialogWrapper>{ui}</DialogWrapper>);
}

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: overrides.id ?? 'task-abc123',
    codespaceId: overrides.codespaceId ?? 'project-1',
    title: overrides.title ?? 'Test task',
    description: overrides.description ?? null,
    mode: overrides.mode ?? 'implement',
    column: overrides.column ?? 'backlog',
    position: overrides.position ?? 0,
    labels: overrides.labels ?? [],
    priority: (overrides as Task & { priority?: string }).priority ?? 'medium',
    branch: null,
    diffSummary: null,
    approvedAt: null,
    approvedBy: null,
    rejectionCount: 0,
    rejectionReason: null,
    agentId: null,
    sessionId: null,
    worktreeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  }) as Task;

describe('TaskHeader', () => {
  describe('Priority controls', () => {
    it('renders priority selector', () => {
      renderWithDialog(<TaskHeader task={createTask()} viewers={[]} onPriorityChange={vi.fn()} />);

      expect(screen.getByText('Priority')).toBeInTheDocument();
      expect(screen.getByText(/high/i)).toBeInTheDocument();
      expect(screen.getByText(/medium/i)).toBeInTheDocument();
      expect(screen.getByText(/low/i)).toBeInTheDocument();
    });

    it('calls onPriorityChange when priority is clicked', () => {
      const onPriorityChange = vi.fn();
      renderWithDialog(
        <TaskHeader task={createTask()} viewers={[]} onPriorityChange={onPriorityChange} />
      );

      fireEvent.click(screen.getByText(/high/i));
      expect(onPriorityChange).toHaveBeenCalledWith('high');

      fireEvent.click(screen.getByText(/low/i));
      expect(onPriorityChange).toHaveBeenCalledWith('low');
    });
  });

  describe('Task ID display', () => {
    it('displays formatted task ID', () => {
      renderWithDialog(
        <TaskHeader
          task={createTask({ id: 'task-xyz789abc' })}
          viewers={[]}
          onPriorityChange={vi.fn()}
        />
      );

      // Should display last 4 chars of ID: 9ABC
      expect(screen.getByText('TSK-9ABC')).toBeInTheDocument();
    });

    it('copies task ID to clipboard when clicked', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      renderWithDialog(
        <TaskHeader
          task={createTask({ id: 'task-full-id-here' })}
          viewers={[]}
          onPriorityChange={vi.fn()}
        />
      );

      const copyButton = screen.getByTitle('Copy full task ID');
      fireEvent.click(copyButton);

      expect(writeTextMock).toHaveBeenCalledWith('task-full-id-here');
    });
  });

  describe('Column status display', () => {
    it.each([
      ['backlog', 'Backlog'],
      ['queued', 'Queued'],
      ['in_progress', 'In Progress'],
      ['waiting_approval', 'Awaiting Review'],
      ['verified', 'Verified'],
    ] as const)('displays correct label for %s column', (column, expectedLabel) => {
      renderWithDialog(
        <TaskHeader task={createTask({ column })} viewers={[]} onPriorityChange={vi.fn()} />
      );

      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    });
  });

  describe('Viewers display', () => {
    it('displays viewer avatars when viewers are present', () => {
      const viewers = [
        { userId: 'user-1', displayName: 'Alice', avatarUrl: undefined, joinedAt: Date.now() },
        { userId: 'user-2', displayName: 'Bob', avatarUrl: undefined, joinedAt: Date.now() },
      ];

      renderWithDialog(
        <TaskHeader task={createTask()} viewers={viewers} onPriorityChange={vi.fn()} />
      );

      expect(screen.getByTitle('Alice')).toBeInTheDocument();
      expect(screen.getByTitle('Bob')).toBeInTheDocument();
    });

    it('shows +N indicator when more than 3 viewers', () => {
      const viewers = [
        { userId: 'user-1', displayName: 'Alice', joinedAt: Date.now() },
        { userId: 'user-2', displayName: 'Bob', joinedAt: Date.now() },
        { userId: 'user-3', displayName: 'Carol', joinedAt: Date.now() },
        { userId: 'user-4', displayName: 'Dave', joinedAt: Date.now() },
      ];

      renderWithDialog(
        <TaskHeader task={createTask()} viewers={viewers} onPriorityChange={vi.fn()} />
      );

      expect(screen.getByText('+1')).toBeInTheDocument();
    });
  });

  describe('Title display', () => {
    it('displays task title', () => {
      renderWithDialog(
        <TaskHeader
          task={createTask({ title: 'My Test Task' })}
          viewers={[]}
          onPriorityChange={vi.fn()}
        />
      );

      expect(screen.getByText('My Test Task')).toBeInTheDocument();
    });
  });
});
