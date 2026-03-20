import { GearSix } from '@phosphor-icons/react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { ApprovalDialog } from '@/app/components/features/approval-dialog';
import { KanbanBoard } from '@/app/components/features/kanban-board';
import { LayoutShell } from '@/app/components/features/layout-shell';

// Lazy-load heavy dialog components (FC-012)
const NewTaskDialog = React.lazy(() =>
  import('@/app/components/features/new-task-dialog').then((m) => ({ default: m.NewTaskDialog }))
);

import { SandboxIndicator } from '@/app/components/features/sandbox-indicator';
import { TaskDetailDialog } from '@/app/components/features/task-detail-dialog/index';
import { AIActionButton } from '@/app/components/ui/ai-action-button';
import { useSandboxStatus } from '@/app/hooks/use-sandbox-status';
import { useToast } from '@/app/hooks/use-toast';
import type { Task } from '@/db/schema';
import { apiClient, type ProjectListItem } from '@/lib/api/client';
import type { DiffSummary } from '@/lib/types/diff';

// Client task type - subset of Task for client-side display
type ClientTask = Pick<
  Task,
  | 'id'
  | 'projectId'
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
  diffSummary?: DiffSummary | null;
};

export const Route = createFileRoute('/projects/$projectId/')({
  loader: async ({ params }: { params: { projectId: string } }) => {
    // Prefetch project and tasks in parallel (FC-022)
    const [projectResult, tasksResult] = await Promise.all([
      apiClient.projects.get(params.projectId),
      apiClient.tasks.list(params.projectId),
    ]);
    return {
      project: projectResult.ok ? projectResult.data : null,
      tasks: tasksResult.ok ? tasksResult.data.items : [],
    };
  },
  component: ProjectKanban,
});

function ProjectKanban(): React.JSX.Element {
  const { projectId } = Route.useParams();
  const loaderData = Route.useLoaderData() as
    | { project: ProjectListItem | null; tasks: ClientTask[] }
    | undefined;
  const { error: showError, warning: showWarning } = useToast();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectListItem | null>(
    (loaderData?.project as ProjectListItem | null) ?? null
  );
  const [tasks, setTasks] = useState<ClientTask[]>((loaderData?.tasks as ClientTask[]) ?? []);
  const [isLoading, setIsLoading] = useState(!loaderData?.project);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<ClientTask | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [approvalTask, setApprovalTask] = useState<ClientTask | null>(null);
  const [isRestartingSandbox, setIsRestartingSandbox] = useState(false);

  // Fetch sandbox status for the title bar indicator
  const {
    data: sandboxStatus,
    isLoading: sandboxLoading,
    refetch: refetchSandboxStatus,
  } = useSandboxStatus(projectId);

  // Handler to restart the sandbox container
  const handleRestartSandbox = async () => {
    setIsRestartingSandbox(true);
    try {
      const response = await fetch(`/api/sandbox/status/${projectId}/restart`, {
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
      console.error('[ProjectKanban] Failed to restart sandbox:', err);
      showError('Failed to restart sandbox', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsRestartingSandbox(false);
    }
  };

  // Fetch project and tasks from API
  const fetchData = useCallback(async () => {
    setError(null);
    setIsLoading(true);

    try {
      const [projectResult, tasksResult] = await Promise.all([
        apiClient.projects.get(projectId),
        apiClient.tasks.list(projectId),
      ]);

      if (!projectResult.ok) {
        console.error('[ProjectKanban] Failed to fetch project:', projectResult.error);
        setError(`Failed to load project: ${projectResult.error.message}`);
        setIsLoading(false);
        return;
      }

      setProject(projectResult.data);

      if (!tasksResult.ok) {
        console.error('[ProjectKanban] Failed to fetch tasks:', tasksResult.error);
        setError(`Failed to load tasks: ${tasksResult.error.message}`);
      } else {
        setTasks(tasksResult.data.items as ClientTask[]);
      }
    } catch (err) {
      console.error('[ProjectKanban] Unexpected error:', err);
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Fetch on mount and when projectId changes
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleTaskMove = async (taskId: string, column: ClientTask['column'], position: number) => {
    // Optimistic update
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, column } : task)));

    // Persist to backend
    const result = await apiClient.tasks.move(taskId, column, position);
    if (!result.ok) {
      console.error('[ProjectKanban] Failed to move task:', result.error);
      showError('Failed to move task', result.error?.message || 'Unknown error');
      // Revert optimistic update on error
      fetchData();
      return;
    }

    // Check for agent startup errors (task moved but agent failed to start)
    const data = result.data as { task: Task; agentError?: string };
    if (data.agentError) {
      console.warn('[ProjectKanban] Agent failed to start:', data.agentError);
      showWarning('Agent failed to start', data.agentError);
    }

    // When moving to in_progress, navigate to the session view to show agent output
    if (column === 'in_progress' && data.task?.sessionId) {
      navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
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
      console.error('[ProjectKanban] Failed to run task:', result.error);
      showError('Failed to start task', result.error?.message || 'Unknown error');
      // Revert optimistic update on error
      fetchData();
      return;
    }

    // Check for agent startup errors (task moved but agent failed to start)
    const data = result.data as { task: Task; agentError?: string };
    if (data.agentError) {
      console.warn('[ProjectKanban] Agent failed to start:', data.agentError);
      showWarning('Agent failed to start', data.agentError);
    }

    // Navigate to the session view to show agent output
    if (data.task?.sessionId) {
      navigate({ to: '/sessions/$sessionId', params: { sessionId: data.task.sessionId } });
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
      console.error('[ProjectKanban] Failed to stop agent:', error);
      showError('Failed to stop agent', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleTaskClick = (task: ClientTask) => {
    if (task.column === 'waiting_approval') {
      setApprovalTask(task);
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
              navigate({ to: '/sessions/$sessionId', params: { sessionId: task.sessionId } });
            }
          }
        }
      );
    } else {
      // TODO: Implement code review approval/rejection API calls for non-plan tasks
      setApprovalTask(null);
      await fetchData();
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
      // TODO: Implement code review approval/rejection API calls for non-plan tasks
      setApprovalTask(null);
      await fetchData();
    }
  };

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: 'Loading...' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading project...</div>
        </div>
      </LayoutShell>
    );
  }

  if (error) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: 'Error' }]}>
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

  if (!project) {
    return <div className="p-6 text-sm text-fg-muted">Project not found.</div>;
  }

  return (
    <LayoutShell
      projectId={project.id}
      projectName={project.name}
      projectPath={project.path}
      breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name }]}
      centerAction={
        <AIActionButton onClick={() => setShowNewTask(true)} data-testid="add-task-button" />
      }
      actions={
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
            to="/projects/$projectId/settings"
            params={{ projectId: project.id }}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-subtle text-fg-muted transition-colors hover:bg-surface hover:text-fg"
            data-testid="project-settings-link"
          >
            <GearSix className="h-4 w-4" />
            <span className="sr-only">Project settings</span>
          </Link>
        </div>
      }
    >
      <KanbanBoard
        tasks={tasks as Parameters<typeof KanbanBoard>[0]['tasks']}
        onTaskMove={handleTaskMove as Parameters<typeof KanbanBoard>[0]['onTaskMove']}
        onTaskClick={handleTaskClick as Parameters<typeof KanbanBoard>[0]['onTaskClick']}
        onRunNow={handleRunNow}
        onStopAgent={handleStopAgent}
      />

      {/* New Task Dialog - AI-powered task creation with streaming (lazy-loaded) */}
      <Suspense fallback={null}>
        <NewTaskDialog
          projectId={projectId}
          open={showNewTask}
          onOpenChange={(open) => {
            if (!open) setShowNewTask(false);
          }}
          onTaskCreated={async (_taskId) => {
            // Refresh tasks list after AI creates a new task
            const tasksResult = await apiClient.tasks.list(projectId);
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
            console.error('[ProjectKanban] Failed to delete task:', result.error);
          }
        }}
        onViewSession={(sessionId) => {
          navigate({ to: '/sessions/$sessionId', params: { sessionId } });
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
                  navigate({
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
