import { Broadcast, GearSix, Kanban as KanbanIcon } from '@phosphor-icons/react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import React, { Suspense, useCallback, useRef, useState } from 'react';
import { ApprovalDialog } from '@/app/components/features/approval-dialog';
import { KanbanBoard } from '@/app/components/features/kanban-board';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

// Lazy-load heavy dialog components (FC-012)
const NewTaskDialog = React.lazy(() =>
  import('@/app/components/features/new-task-dialog').then((m) => ({ default: m.NewTaskDialog }))
);

import { LiveTaskView } from '@/app/components/features/live-task-view';
import { SandboxIndicator } from '@/app/components/features/sandbox-indicator';
import { TaskDetailDialog } from '@/app/components/features/task-detail-dialog/index';
import { AIActionButton } from '@/app/components/ui/ai-action-button';
import { useSandboxStatus } from '@/app/hooks/use-sandbox-status';
import { useToast } from '@/app/hooks/use-toast';
import type { Task } from '@/db/schema';
import { apiClient, type CodespaceListItem } from '@/lib/api/client';
import type { DiffSummary } from '@/lib/types/diff';
import { cn } from '@/lib/utils/cn';

// Client task type - subset of Task for client-side display
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
  | 'skillId'
  | 'skillName'
  | 'createdAt'
  | 'updatedAt'
> & {
  priority?: 'low' | 'medium' | 'high';
  diffSummary?: DiffSummary | null;
};

export const Route = createFileRoute('/codespaces/$codespaceId/')({
  loader: async ({ params }: { params: { codespaceId: string } }) => {
    // Prefetch codespace and tasks in parallel (FC-022)
    const [codespaceResult, tasksResult] = await Promise.all([
      apiClient.codespaces.get(params.codespaceId),
      apiClient.tasks.list(params.codespaceId),
    ]);
    return {
      codespace: codespaceResult.ok ? codespaceResult.data : null,
      tasks: tasksResult.ok ? tasksResult.data.items : [],
    };
  },
  component: CodespaceKanban,
});

function CodespaceKanban(): React.JSX.Element {
  const { codespaceId } = Route.useParams();
  const loaderData = Route.useLoaderData() as
    | { codespace: CodespaceListItem | null; tasks: ClientTask[] }
    | undefined;
  const { error: showError, warning: showWarning } = useToast();
  const navigate = useNavigate();
  const [codespace, setCodespace] = useState<CodespaceListItem | null>(
    (loaderData?.codespace as CodespaceListItem | null) ?? null
  );
  const [tasks, setTasks] = useState<ClientTask[]>((loaderData?.tasks as ClientTask[]) ?? []);
  const [isLoading, setIsLoading] = useState(!loaderData?.codespace);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<ClientTask | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [approvalTask, setApprovalTask] = useState<ClientTask | null>(null);
  const [isRestartingSandbox, setIsRestartingSandbox] = useState(false);
  const [viewMode, setViewMode] = useState<'kanban' | 'live'>('kanban');

  // Fetch sandbox status for the title bar indicator
  const {
    data: sandboxStatus,
    isLoading: sandboxLoading,
    refetch: refetchSandboxStatus,
  } = useSandboxStatus(codespaceId);

  // Handler to restart the sandbox container
  const handleRestartSandbox = async () => {
    setIsRestartingSandbox(true);
    try {
      const response = await fetch(`/api/sandbox/status/${codespaceId}/restart`, {
        method: 'POST',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        showError('Failed to restart sandbox', error.error?.message || 'Unknown error');
        return;
      }
      // Refetch sandbox status after restart
      refetchSandboxStatus();
    } catch (err) {
      console.error('[CodespaceKanban] Failed to restart sandbox:', err);
      showError('Failed to restart sandbox', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsRestartingSandbox(false);
    }
  };

  // Fetch codespace and tasks from API
  const fetchData = useCallback(async () => {
    setError(null);
    setIsLoading(true);

    try {
      const [codespaceResult, tasksResult] = await Promise.all([
        apiClient.codespaces.get(codespaceId),
        apiClient.tasks.list(codespaceId),
      ]);

      if (!codespaceResult.ok) {
        console.error('[CodespaceKanban] Failed to fetch codespace:', codespaceResult.error);
        setError(`Failed to load codespace: ${codespaceResult.error.message}`);
        setIsLoading(false);
        return;
      }

      setCodespace(codespaceResult.data);

      if (!tasksResult.ok) {
        console.error('[CodespaceKanban] Failed to fetch tasks:', tasksResult.error);
        setError(`Failed to load tasks: ${tasksResult.error.message}`);
      } else {
        setTasks(tasksResult.data.items as ClientTask[]);
      }
    } catch (err) {
      console.error('[CodespaceKanban] Unexpected error:', err);
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [codespaceId]);

  // Re-fetch when codespaceId changes. On initial mount, use loader data if available.
  // On subsequent codespaceId changes (navigating between codespaces), always re-fetch
  // since useState keeps stale data from the previous codespace.
  const prevCodespaceIdRef = useRef(codespaceId);
  useWatchEffect(() => {
    const isInitialMount = prevCodespaceIdRef.current === codespaceId;
    if (isInitialMount && loaderData?.codespace) {
      // Loader already provided data for this codespace
      prevCodespaceIdRef.current = codespaceId;
      return;
    }
    prevCodespaceIdRef.current = codespaceId;
    void fetchData();
  }, [codespaceId, fetchData, loaderData]);

  const handleTaskMove = async (taskId: string, column: ClientTask['column'], position: number) => {
    // Optimistic update
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, column } : task)));

    // Persist to backend
    const result = await apiClient.tasks.move(taskId, column, position);
    if (!result.ok) {
      console.error('[CodespaceKanban] Failed to move task:', result.error);
      showError('Failed to move task', result.error?.message || 'Unknown error');
      // Revert optimistic update on error
      void fetchData();
      return;
    }

    // Check for agent startup errors (task moved but agent failed to start)
    const data = result.data as { task: Task; agentError?: string };
    if (data.agentError) {
      console.warn('[CodespaceKanban] Agent failed to start:', data.agentError);
      showWarning('Agent failed to start', data.agentError);
    }

    // When moving to in_progress, navigate to the session view to show agent output
    if (column === 'in_progress' && data.task?.sessionId) {
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
    }
  };

  const handleRunNow = async (taskId: string) => {
    // Optimistic update - move to in_progress
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, column: 'in_progress' as const } : task))
    );

    // Move task to in_progress which will auto-trigger the agent
    const result = await apiClient.tasks.move(taskId, 'in_progress', 0);
    if (!result.ok) {
      console.error('[CodespaceKanban] Failed to run task:', result.error);
      showError('Failed to start task', result.error?.message || 'Unknown error');
      // Revert optimistic update on error
      void fetchData();
      return;
    }

    // Check for agent startup errors (task moved but agent failed to start)
    const data = result.data as { task: Task; agentError?: string };
    if (data.agentError) {
      console.warn('[CodespaceKanban] Agent failed to start:', data.agentError);
      showWarning('Agent failed to start', data.agentError);
    }

    // Navigate to the session view to show agent output
    if (data.task?.sessionId) {
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
    }
  };

  const handleStopAgent = async (taskId: string) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/stop-agent`, {
        method: 'POST',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        showError('Failed to stop agent', error.message || 'Unknown error');
        return;
      }
      // Refresh to get updated task state
      await fetchData();
    } catch (error) {
      console.error('[CodespaceKanban] Failed to stop agent:', error);
      showError('Failed to stop agent', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleCancelTask = async (taskId: string) => {
    try {
      const result = await apiClient.tasks.cancel(taskId);
      if (!result.ok) {
        showError(
          'Failed to cancel task',
          (result.error as { message?: string })?.message || 'Unknown error'
        );
        return;
      }
      await fetchData();
    } catch (error) {
      console.error('[CodespaceKanban] Failed to cancel task:', error);
      showError('Failed to cancel task', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleTaskClick = (task: ClientTask) => {
    if (task.column === 'waiting_approval') {
      setApprovalTask(task);
    } else if (task.sessionId) {
      // Navigate to the full session view for tasks with active/completed sessions
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: task.sessionId } });
    } else {
      setSelectedTask(task);
    }
  };

  const isTaskPlanReview = (task: ClientTask): boolean =>
    task.lastAgentStatus === 'planning' && !!task.plan;

  /**
   * Shared helper for plan approval/rejection actions.
   * Handles error display, dialog cleanup, and data refresh.
   */
  const withPlanAction = async (
    action: () => Promise<{ ok: boolean; error?: { message?: string } }>,
    errorLabel: string,
    onSuccess?: () => Promise<void>
  ) => {
    if (!approvalTask) return;

    try {
      const result = await action();
      if (!result.ok) {
        showError(errorLabel, (result.error as { message?: string })?.message || 'Unknown error');
        setApprovalTask(null);
        return;
      }
      if (onSuccess) {
        await onSuccess();
      }
      setApprovalTask(null);
      await fetchData();
    } catch (error) {
      showError(errorLabel, error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleApprove = async (_commitMessage?: string) => {
    if (!approvalTask) return;

    if (isTaskPlanReview(approvalTask)) {
      await withPlanAction(
        () => apiClient.tasks.approvePlan(approvalTask.id),
        'Failed to approve plan',
        async () => {
          // Navigate to session view if available
          const taskResult = await apiClient.tasks.get(approvalTask.id);
          if (taskResult.ok) {
            const task = taskResult.data as ClientTask;
            if (task.sessionId) {
              void navigate({ to: '/sessions/$sessionId', params: { sessionId: task.sessionId } });
            }
          }
        }
      );
    } else {
      await withPlanAction(
        () =>
          apiClient.tasks.approve(approvalTask.id, {
            approvedBy: 'user',
            createMergeCommit: true,
          }),
        'Approval failed'
      );
    }
  };

  const handleReject = async (reason: string) => {
    if (!approvalTask) return;

    if (isTaskPlanReview(approvalTask)) {
      await withPlanAction(
        () => apiClient.tasks.rejectPlan(approvalTask.id, reason),
        'Failed to reject plan'
      );
    } else {
      await withPlanAction(
        () => apiClient.tasks.reject(approvalTask.id, reason),
        'Rejection failed'
      );
    }
  };

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Codespaces', to: '/codespaces' }, { label: 'Loading...' }]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading codespace...</div>
        </div>
      </LayoutShell>
    );
  }

  if (error) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Codespaces', to: '/codespaces' }, { label: 'Error' }]}>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <div className="text-destructive text-sm">{error}</div>
          <button
            type="button"
            onClick={() => fetchData()}
            className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </LayoutShell>
    );
  }

  if (!codespace) {
    return <div className="p-6 text-sm text-fg-muted">Codespace not found.</div>;
  }

  return (
    <LayoutShell
      codespaceId={codespace.id}
      codespaceName={codespace.name}
      codespacePath={codespace.path}
      header={
        <header
          className="flex items-center gap-4 border-b border-border bg-surface px-4 py-3 sm:px-6 sm:py-4"
          data-testid="layout-header"
        >
          {/* Breadcrumbs */}
          <div className="flex items-center gap-2 text-sm">
            <Link to="/codespaces" className="text-fg-muted hover:text-fg transition-colors">
              Codespaces
            </Link>
            <span className="text-fg-subtle">/</span>
            <span className="font-medium text-fg">{codespace.name}</span>
          </div>

          {/* View mode toggle — left-aligned, prominent */}
          <div
            className="flex items-center rounded-lg border border-border bg-surface-subtle p-0.5"
            data-testid="view-mode-toggle"
          >
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                viewMode === 'kanban'
                  ? 'bg-surface-emphasis text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg'
              )}
              data-testid="view-mode-kanban"
            >
              <KanbanIcon size={16} weight={viewMode === 'kanban' ? 'fill' : 'regular'} />
              Kanban
            </button>
            <button
              type="button"
              onClick={() => setViewMode('live')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                viewMode === 'live'
                  ? 'bg-surface-emphasis text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg'
              )}
              data-testid="view-mode-live"
            >
              <Broadcast size={16} weight={viewMode === 'live' ? 'fill' : 'regular'} />
              Live
            </button>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Center: AI Action Button */}
          <AIActionButton onClick={() => setShowNewTask(true)} data-testid="add-task-button" />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Right: Sandbox + Settings */}
          <div className="flex items-center gap-2">
            {sandboxStatus && (
              <SandboxIndicator
                mode={sandboxStatus.mode}
                containerStatus={sandboxStatus.containerStatus}
                providerAvailable={sandboxStatus.providerAvailable}
                provider={sandboxStatus.provider}
                isLoading={sandboxLoading}
                isRestarting={isRestartingSandbox}
                onRestart={handleRestartSandbox}
                k8sCrdReady={sandboxStatus.k8sCrdReady}
                k8sClusterVersion={sandboxStatus.k8sClusterVersion}
                k8sPodCount={sandboxStatus.k8sPodCount}
                k8sPodsRunning={sandboxStatus.k8sPodsRunning}
                nomadHealthy={sandboxStatus.nomadHealthy}
                nomadVersion={sandboxStatus.nomadVersion}
                nomadLeader={sandboxStatus.nomadLeader}
                nomadJobCount={sandboxStatus.nomadJobCount}
              />
            )}
            <Link
              to="/codespaces/$codespaceId/settings"
              params={{ codespaceId: codespace.id }}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-subtle text-fg-muted transition-colors hover:bg-surface hover:text-fg"
              data-testid="codespace-settings-link"
            >
              <GearSix className="h-4 w-4" />
              <span className="sr-only">Codespace settings</span>
            </Link>
          </div>
        </header>
      }
    >
      {viewMode === 'kanban' ? (
        <KanbanBoard
          tasks={tasks as Parameters<typeof KanbanBoard>[0]['tasks']}
          onTaskMove={handleTaskMove as Parameters<typeof KanbanBoard>[0]['onTaskMove']}
          onTaskClick={handleTaskClick as Parameters<typeof KanbanBoard>[0]['onTaskClick']}
          onRunNow={handleRunNow}
          onStopAgent={handleStopAgent}
          onCancelTask={handleCancelTask}
        />
      ) : (
        <LiveTaskView
          tasks={tasks}
          codespaceId={codespaceId}
          onTaskMove={handleTaskMove as (taskId: string, column: string, position: number) => void}
          onTaskClick={handleTaskClick as (task: { id: string; column: string }) => void}
          onApproveTask={(taskId) => {
            const task = tasks.find((t) => t.id === taskId);
            if (task) setApprovalTask(task);
          }}
          onDeleteTask={async (taskId) => {
            const result = await apiClient.tasks.delete(taskId);
            if (result.ok) {
              setTasks((prev) => prev.filter((t) => t.id !== taskId));
            } else {
              showError(
                'Failed to delete task',
                (result.error as { message?: string })?.message || 'Unknown error'
              );
            }
          }}
          onStopAgent={handleStopAgent}
          onCancelTask={handleCancelTask}
        />
      )}

      {/* New Task Dialog - AI-powered task creation with streaming (lazy-loaded) */}
      <Suspense fallback={null}>
        <NewTaskDialog
          codespaceId={codespaceId}
          open={showNewTask}
          onOpenChange={(open) => {
            if (!open) setShowNewTask(false);
          }}
          onTaskCreated={async (_taskId) => {
            // Refresh tasks list after AI creates a new task
            const tasksResult = await apiClient.tasks.list(codespaceId);
            if (tasksResult.ok) {
              setTasks(tasksResult.data.items as ClientTask[]);
            }
          }}
        />
      </Suspense>

      {/* Edit Task Dialog - uses new dialog with mode toggle */}
      <TaskDetailDialog
        task={selectedTask as Parameters<typeof TaskDetailDialog>[0]['task']}
        open={Boolean(selectedTask)}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
        onSave={async (data) => {
          if (selectedTask) {
            // Persist to API
            const result = await apiClient.tasks.update(selectedTask.id, data);
            if (!result.ok) {
              console.error('[CodespaceKanban] Failed to update task:', result.error);
            }
            // Optimistic local update
            setTasks((prev) =>
              prev.map((task) => (task.id === selectedTask.id ? { ...task, ...data } : task))
            );
          }
        }}
        onTaskUpdated={(data) => {
          if (selectedTask) {
            setTasks((prev) =>
              prev.map((task) => (task.id === selectedTask.id ? { ...task, ...data } : task))
            );
          }
        }}
        onDelete={async (id) => {
          const result = await apiClient.tasks.delete(id);
          if (result.ok) {
            setTasks((prev) => prev.filter((task) => task.id !== id));
          } else {
            console.error('[CodespaceKanban] Failed to delete task:', result.error);
          }
        }}
        onMoveColumn={async (taskId, column) => {
          await handleTaskMove(taskId, column, 0);
          setSelectedTask(null);
        }}
        onStopAgent={async (taskId) => {
          await handleStopAgent(taskId);
        }}
        onViewSession={(sessionId) => {
          void navigate({ to: '/sessions/$sessionId', params: { sessionId } });
        }}
      />

      {approvalTask && (
        <ApprovalDialog
          task={approvalTask as Parameters<typeof ApprovalDialog>[0]['task']}
          diff={approvalTask.diffSummary ?? null}
          open={Boolean(approvalTask)}
          onOpenChange={(open) => {
            if (!open) {
              setApprovalTask(null);
            }
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          onViewSession={
            approvalTask.sessionId
              ? () => {
                  void navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: approvalTask.sessionId as string },
                  });
                }
              : undefined
          }
        />
      )}
    </LayoutShell>
  );
}
