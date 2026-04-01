/**
 * FC-004: Shared task operation handlers extracted from
 * routes/codespaces/$codespaceId/index.tsx.
 *
 * Centralizes task move, run-now, stop-agent, approve/reject plan logic
 * so it can be reused across route components without duplication.
 */

import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useToast } from '@/app/hooks/use-toast';
import type { Task } from '@/db/schema';
import { apiClient } from '@/lib/api/client';

// Client task type -- minimal subset for task operations
type ClientTask = Pick<
  Task,
  | 'id'
  | 'codespaceId'
  | 'title'
  | 'description'
  | 'column'
  | 'position'
  | 'labels'
  | 'agentId'
  | 'sessionId'
  | 'lastAgentStatus'
  | 'plan'
  | 'branch'
> & {
  priority?: 'low' | 'medium' | 'high';
};

export interface UseTaskOperationsOptions {
  /** Callback invoked after any mutation to refresh data */
  onRefresh: () => Promise<void> | void;
  /** Callback for optimistic task list updates */
  onOptimisticUpdate?: (updater: (tasks: ClientTask[]) => ClientTask[]) => void;
}

export interface TaskOperations {
  /** Move a task to a column/position (drag-drop) */
  handleTaskMove: (taskId: string, column: ClientTask['column'], position: number) => Promise<void>;
  /** Run a backlog task immediately (moves to in_progress) */
  handleRunNow: (taskId: string) => Promise<void>;
  /** Stop the agent running on a task */
  handleStopAgent: (taskId: string) => Promise<void>;
  /** Approve a plan or waiting_approval task */
  handleApprove: (task: ClientTask, commitMessage?: string) => Promise<void>;
  /** Reject a plan with a reason */
  handleReject: (task: ClientTask, reason: string) => Promise<void>;
  /** Check whether a task is in plan-review state */
  isTaskPlanReview: (task: ClientTask) => boolean;
}

export function useTaskOperations(
  _codespaceId: string,
  options: UseTaskOperationsOptions
): TaskOperations {
  const { error: showError } = useToast();
  const navigate = useNavigate();
  const { onRefresh, onOptimisticUpdate } = options;

  const handleTaskMove = useCallback(
    async (taskId: string, column: ClientTask['column'], position: number) => {
      // Optimistic update
      onOptimisticUpdate?.((prev) =>
        prev.map((task) => (task.id === taskId ? { ...task, column } : task))
      );

      const result = await apiClient.tasks.move(taskId, column, position);
      if (!result.ok) {
        console.error('[useTaskOperations] Failed to move task:', result.error);
        showError('Failed to move task', result.error?.message || 'Unknown error');
        await onRefresh();
        return;
      }

      const data = result.data as { task: Task; agentError?: string };
      if (data.agentError) {
        console.error('[useTaskOperations] Agent failed to start:', data.agentError);
        showError('Agent failed to start', data.agentError);
        // Task was reverted to backlog by the server — refresh to reflect the revert
        await onRefresh();
        return;
      }

      if (column === 'in_progress' && data.task?.sessionId) {
        navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
      }
    },
    [onOptimisticUpdate, onRefresh, showError, navigate]
  );

  const handleRunNow = useCallback(
    async (taskId: string) => {
      onOptimisticUpdate?.((prev) =>
        prev.map((task) =>
          task.id === taskId ? { ...task, column: 'in_progress' as const } : task
        )
      );

      const result = await apiClient.tasks.move(taskId, 'in_progress', 0);
      if (!result.ok) {
        console.error('[useTaskOperations] Failed to run task:', result.error);
        showError('Failed to start task', result.error?.message || 'Unknown error');
        await onRefresh();
        return;
      }

      const data = result.data as { task: Task; agentError?: string };
      if (data.agentError) {
        console.error('[useTaskOperations] Agent failed to start:', data.agentError);
        showError('Agent failed to start', data.agentError);
        // Task was reverted to backlog by the server — refresh to reflect the revert
        await onRefresh();
        return;
      }

      if (data.task?.sessionId) {
        navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
      }
    },
    [onOptimisticUpdate, onRefresh, showError, navigate]
  );

  const handleStopAgent = useCallback(
    async (taskId: string) => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/stop-agent`, {
          method: 'POST',
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          showError('Failed to stop agent', error.message || 'Unknown error');
          return;
        }
        await onRefresh();
      } catch (error) {
        console.error('[useTaskOperations] Failed to stop agent:', error);
        showError('Failed to stop agent', error instanceof Error ? error.message : 'Unknown error');
      }
    },
    [onRefresh, showError]
  );

  const isTaskPlanReview = useCallback(
    (task: ClientTask): boolean => task.lastAgentStatus === 'planning' && !!task.plan,
    []
  );

  const handleApprove = useCallback(
    async (task: ClientTask, _commitMessage?: string) => {
      if (isTaskPlanReview(task)) {
        try {
          const result = await apiClient.tasks.approvePlan(task.id);
          if (!result.ok) {
            showError(
              'Failed to approve plan',
              (result.error as { message?: string })?.message || 'Unknown error'
            );
            return;
          }
          // Navigate to session view if available
          const taskResult = await apiClient.tasks.get(task.id);
          if (taskResult.ok) {
            const updatedTask = taskResult.data as ClientTask;
            if (updatedTask.sessionId) {
              navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: updatedTask.sessionId },
              });
            }
          }
          await onRefresh();
        } catch (error) {
          showError(
            'Failed to approve plan',
            error instanceof Error ? error.message : 'Unknown error'
          );
        }
      } else {
        // TODO: Implement code review approval/rejection API calls for non-plan tasks
        await onRefresh();
      }
    },
    [isTaskPlanReview, onRefresh, showError, navigate]
  );

  const handleReject = useCallback(
    async (task: ClientTask, reason: string) => {
      if (isTaskPlanReview(task)) {
        try {
          const result = await apiClient.tasks.rejectPlan(task.id, reason);
          if (!result.ok) {
            showError(
              'Failed to reject plan',
              (result.error as { message?: string })?.message || 'Unknown error'
            );
            return;
          }
          await onRefresh();
        } catch (error) {
          showError(
            'Failed to reject plan',
            error instanceof Error ? error.message : 'Unknown error'
          );
        }
      } else {
        // TODO: Implement code review approval/rejection API calls for non-plan tasks
        await onRefresh();
      }
    },
    [isTaskPlanReview, onRefresh, showError]
  );

  return {
    handleTaskMove,
    handleRunNow,
    handleStopAgent,
    handleApprove,
    handleReject,
    isTaskPlanReview,
  };
}
