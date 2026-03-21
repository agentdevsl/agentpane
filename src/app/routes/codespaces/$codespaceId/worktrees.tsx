import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { WorktreeManagement } from '@/app/components/features/worktree-management';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type CodespaceListItem } from '@/lib/api/client';

export const Route = createFileRoute('/codespaces/$codespaceId/worktrees')({
  loader: async ({ params }: { params: { codespaceId: string } }) => {
    const result = await apiClient.codespaces.get(params.codespaceId);
    return { codespace: result.ok ? result.data : null };
  },
  component: CodespaceWorktreesPage,
});

function CodespaceWorktreesPage(): React.JSX.Element {
  const { codespaceId } = Route.useParams();
  const loaderData = Route.useLoaderData() as { codespace: CodespaceListItem | null } | undefined;
  const [codespace, setCodespace] = useState<CodespaceListItem | null>(
    () => (loaderData?.codespace as CodespaceListItem) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.codespace);
  const [error, setError] = useState<string | null>(null);

  // Fetch codespace from API
  useWatchEffect(() => {
    if (loaderData?.codespace) return;
    const fetchCodespace = async () => {
      try {
        const result = await apiClient.codespaces.get(codespaceId);
        if (result.ok) {
          setCodespace(result.data);
        } else {
          console.error('[CodespaceWorktreesPage] Failed to fetch codespace:', result.error);
          setError(result.error.message);
        }
      } catch (err) {
        console.error('[CodespaceWorktreesPage] Exception fetching codespace:', err);
        setError(err instanceof Error ? err.message : 'Failed to load codespace');
      } finally {
        setIsLoading(false);
      }
    };
    void fetchCodespace();
  }, [codespaceId, loaderData]);

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Codespaces', to: '/codespaces' },
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
          { label: 'Codespaces', to: '/codespaces' },
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
      projectId={codespaceId}
      projectName={codespace?.name}
      projectPath={codespace?.path}
      breadcrumbs={[
        { label: 'Codespaces', to: '/codespaces' },
        { label: codespace?.name ?? 'Codespace', to: `/codespaces/${codespaceId}` },
        { label: 'Worktrees' },
      ]}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <WorktreeManagement projectId={codespaceId} />
      </div>
    </LayoutShell>
  );
}
