import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { WorktreeManagement } from '@/app/components/features/worktree-management';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient, type ProjectListItem } from '@/lib/api/client';

export const Route = createFileRoute('/worktrees/')({
  loader: async () => {
    const result = await apiClient.projects.list({ limit: 1 });
    return { project: result.ok ? (result.data.items[0] ?? null) : null };
  },
  component: WorktreesPage,
});

function WorktreesPage(): React.JSX.Element {
  const loaderData = Route.useLoaderData() as { project: ProjectListItem | null } | undefined;
  const [project, setProject] = useState<ProjectListItem | null>(
    () => (loaderData?.project as ProjectListItem) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData);
  const [error, setError] = useState<string | null>(null);

  // Fetch project from API on mount
  useMountEffect(() => {
    if (loaderData?.project !== undefined) return;
    const fetchData = async () => {
      try {
        const projectsResult = await apiClient.projects.list({ limit: 1 });
        if (projectsResult.ok) {
          setProject(projectsResult.data.items[0] ?? null);
        } else {
          console.error('[WorktreesPage] Failed to fetch projects:', projectsResult.error);
          setError(projectsResult.error.message);
        }
      } catch (err) {
        console.error('[WorktreesPage] Exception fetching projects:', err);
        setError(err instanceof Error ? err.message : 'Failed to load projects');
      } finally {
        setIsLoading(false);
      }
    };
    void fetchData();
  });

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Worktrees' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </LayoutShell>
    );
  }

  if (error) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Worktrees' }]}>
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
      breadcrumbs={[{ label: 'Worktrees' }]}
      projectName={project?.name}
      projectPath={project?.path}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        {project ? (
          <WorktreeManagement projectId={project.id} />
        ) : (
          <EmptyState
            preset="no-projects"
            title="No project selected"
            subtitle="Add a project to see worktrees."
          />
        )}
      </div>
    </LayoutShell>
  );
}
