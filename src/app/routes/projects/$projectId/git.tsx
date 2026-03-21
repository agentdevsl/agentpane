import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { GitView } from '@/app/components/features/git-view';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { apiClient, type ProjectListItem } from '@/lib/api/client';

export const Route = createFileRoute('/projects/$projectId/git')({
  loader: async ({ params }: { params: { projectId: string } }) => {
    const result = await apiClient.projects.get(params.projectId);
    return { project: result.ok ? result.data : null };
  },
  component: ProjectGitPage,
});

function ProjectGitPage(): React.JSX.Element {
  const { projectId } = Route.useParams();
  const loaderData = Route.useLoaderData() as { project: ProjectListItem | null } | undefined;
  const [project, setProject] = useState<ProjectListItem | null>(
    () => (loaderData?.project as ProjectListItem) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.project);
  const [error, setError] = useState<string | null>(null);

  // Fetch project from API
  useEffect(() => {
    if (loaderData?.project) return;
    const fetchProject = async () => {
      try {
        const result = await apiClient.projects.get(projectId);
        if (result.ok) {
          setProject(result.data);
        } else {
          console.error('[ProjectGitPage] Failed to fetch project:', result.error);
          setError(result.error.message);
        }
      } catch (err) {
        console.error('[ProjectGitPage] Exception fetching project:', err);
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
          { label: 'Git' },
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
        breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: 'Error' }, { label: 'Git' }]}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-6">
            <p className="text-sm font-medium text-danger">Failed to load project</p>
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
        { label: 'Git' },
      ]}
    >
      <div className="flex-1 overflow-hidden p-6">
        <GitView projectId={projectId} projectPath={project?.path} />
      </div>
    </LayoutShell>
  );
}
