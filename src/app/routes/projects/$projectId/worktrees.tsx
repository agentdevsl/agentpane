import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { WorktreeManagement } from '@/app/components/features/worktree-management';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type ProjectListItem } from '@/lib/api/client';

export const Route = createFileRoute('/projects/$projectId/worktrees')({
  loader: async ({ params }: { params: { projectId: string } }) => {
    const result = await apiClient.projects.get(params.projectId);
    return { project: result.ok ? result.data : null };
  },
  component: ProjectWorktreesPage,
});

function ProjectWorktreesPage(): React.JSX.Element {
  const { projectId } = Route.useParams();
  const loaderData = Route.useLoaderData() as { project: ProjectListItem | null } | undefined;
  const [project, setProject] = useState<ProjectListItem | null>(
    () => (loaderData?.project as ProjectListItem) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.project);
  const [error, setError] = useState<string | null>(null);

  // Fetch project from API
  useWatchEffect(() => {
    if (loaderData?.project) return;
    const fetchProject = async () => {
      try {
        const result = await apiClient.projects.get(projectId);
        if (result.ok) {
          setProject(result.data);
        } else {
          console.error('[ProjectWorktreesPage] Failed to fetch project:', result.error);
          setError(result.error.message);
        }
      } catch (err) {
        console.error('[ProjectWorktreesPage] Exception fetching project:', err);
        setError(err instanceof Error ? err.message : 'Failed to load project');
      } finally {
        setIsLoading(false);
      }
    };
    void fetchProject();
  }, [projectId, loaderData]);

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Projects', to: '/projects' },
          { label: 'Loading...' },
          { label: 'Worktrees' },
        ]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </LayoutShell>
    );
  }

  if (error) {
    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Projects', to: '/projects' },
          { label: 'Error' },
          { label: 'Worktrees' },
        ]}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-6">
            <p className="text-sm font-medium text-danger">Failed to load worktrees</p>
            <p className="mt-1 text-sm text-fg-muted">{error}</p>
          </div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      projectId={projectId}
      projectName={project?.name}
      projectPath={project?.path}
      breadcrumbs={[
        { label: 'Projects', to: '/projects' },
        { label: project?.name ?? 'Project', to: `/projects/${projectId}` },
        { label: 'Worktrees' },
      ]}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <WorktreeManagement projectId={projectId} />
      </div>
    </LayoutShell>
  );
}
