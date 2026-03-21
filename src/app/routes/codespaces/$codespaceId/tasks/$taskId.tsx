import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { TaskDetailDialog } from '@/app/components/features/task-detail-dialog';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { Task } from '@/db/schema';
import { apiClient, type CodespaceListItem } from '@/lib/api/client';

// Client task type - subset of Task for client-side display
type ClientTask = Pick<
  Task,
  'id' | 'projectId' | 'title' | 'description' | 'column' | 'position' | 'sessionId'
> & {
  priority?: 'low' | 'medium' | 'high' | 'critical';
};

export const Route = createFileRoute('/codespaces/$codespaceId/tasks/$taskId')({
  loader: async ({ params }: { params: { codespaceId: string; taskId: string } }) => {
    const [taskResult, codespaceResult] = await Promise.all([
      apiClient.tasks.get(params.taskId),
      apiClient.codespaces.get(params.codespaceId),
    ]);
    const task = taskResult.ok ? taskResult.data : null;
    return {
      task: task && (task as ClientTask).projectId === params.codespaceId ? task : null,
      codespace: codespaceResult.ok ? codespaceResult.data : null,
    };
  },
  component: TaskDetailRoute,
});

function TaskDetailRoute(): React.JSX.Element {
  const router = useRouter();
  const { codespaceId, taskId } = Route.useParams();
  const loaderData = Route.useLoaderData() as
    | { task: ClientTask | null; codespace: CodespaceListItem | null }
    | undefined;
  const [task, setTask] = useState<ClientTask | null>(
    () => (loaderData?.task as ClientTask) ?? null
  );
  const [codespace, setCodespace] = useState<CodespaceListItem | null>(
    () => (loaderData?.codespace as CodespaceListItem) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.task);

  // Fetch task and codespace from API on mount
  useWatchEffect(() => {
    if (loaderData?.task) return;
    const fetchData = async () => {
      const [taskResult, codespaceResult] = await Promise.all([
        apiClient.tasks.get(taskId),
        apiClient.codespaces.get(codespaceId),
      ]);

      if (taskResult.ok) {
        const fetchedTask = taskResult.data as ClientTask;
        if (fetchedTask.projectId === codespaceId) {
          setTask(fetchedTask);
        }
      }
      if (codespaceResult.ok) {
        setCodespace(codespaceResult.data);
      }
      setIsLoading(false);
    };
    fetchData();
  }, [codespaceId, taskId, loaderData]);

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Codespaces', to: '/codespaces' }, { label: 'Loading...' }]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading task...</div>
        </div>
      </LayoutShell>
    );
  }

  if (!task) {
    return <div className="p-6 text-sm text-fg-muted">Task not found.</div>;
  }

  return (
    <LayoutShell
      projectId={codespace?.id}
      projectName={codespace?.name}
      projectPath={codespace?.path}
      breadcrumbs={[
        { label: 'Codespaces', to: '/codespaces' },
        { label: codespace?.name ?? 'Codespace', to: `/codespaces/${codespace?.id}` },
        { label: task.title },
      ]}
    >
      <TaskDetailDialog
        task={task as Parameters<typeof TaskDetailDialog>[0]['task']}
        open
        onOpenChange={(open) => {
          if (!open) {
            router.navigate({
              to: '/codespaces/$codespaceId',
              params: { codespaceId },
            });
          }
        }}
        onSave={async (data) => {
          // TODO: [CQ-018] Add API endpoint for updating tasks
          setTask((prev) => (prev ? { ...prev, ...data } : null));
        }}
        onDelete={async (_id) => {
          // TODO: [CQ-018] Add API endpoint for deleting tasks
        }}
        onViewSession={(sessionId) => {
          window.location.href = `/codespaces/${codespaceId}/sessions/${sessionId}`;
        }}
      />
    </LayoutShell>
  );
}
