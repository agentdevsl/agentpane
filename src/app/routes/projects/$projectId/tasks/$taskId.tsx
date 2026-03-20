import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { TaskDetailDialog } from '@/app/components/features/task-detail-dialog';
import type { Task } from '@/db/schema';
import { apiClient, type ProjectListItem } from '@/lib/api/client';

// Client task type - subset of Task for client-side display
type ClientTask = Pick<
  Task,
  'id' | 'projectId' | 'title' | 'description' | 'column' | 'position' | 'sessionId'
> & {
  priority?: 'low' | 'medium' | 'high' | 'critical';
};

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
  component: TaskDetailRoute,
});

function TaskDetailRoute(): React.JSX.Element {
  const router = useRouter();
  const { projectId, taskId } = Route.useParams();
  const [task, setTask] = useState<ClientTask | null>(null);
  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch task and project from API on mount
  useEffect(() => {
    const fetchData = async () => {
      const [taskResult, projectResult] = await Promise.all([
        apiClient.tasks.get(taskId),
        apiClient.projects.get(projectId),
      ]);

      if (taskResult.ok) {
        const fetchedTask = taskResult.data as ClientTask;
        if (fetchedTask.projectId === projectId) {
          setTask(fetchedTask);
        }
      }
      if (projectResult.ok) {
        setProject(projectResult.data);
      }
      setIsLoading(false);
    };
    fetchData();
  }, [projectId, taskId]);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: 'Loading...' }]}>
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
      projectId={project?.id}
      projectName={project?.name}
      projectPath={project?.path}
      breadcrumbs={[
        { label: 'Projects', to: '/projects' },
        { label: project?.name ?? 'Project', to: `/projects/${project?.id}` },
        { label: task.title },
      ]}
    >
      <TaskDetailDialog
        task={task as Parameters<typeof TaskDetailDialog>[0]['task']}
        open
        onOpenChange={(open) => {
          if (!open) {
            router.navigate({ to: '/projects/$projectId', params: { projectId } });
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
          window.location.href = `/projects/${projectId}/sessions/${sessionId}`;
        }}
      />
    </LayoutShell>
  );
}
