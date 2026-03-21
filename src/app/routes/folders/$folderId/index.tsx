import { Folder, MagnifyingGlass, Spinner } from '@phosphor-icons/react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type CodespaceListItem } from '@/lib/api/client';

type FolderData = {
  id: string;
  name: string;
  description?: string | null;
  codespaceCount?: number;
};

export const Route = createFileRoute('/folders/$folderId/')({
  loader: async ({ params }: { params: { folderId: string } }) => {
    const [folderResult, codespacesResult] = await Promise.all([
      apiClient.projectFolders.get(params.folderId),
      apiClient.projectFolders.listCodespaces(params.folderId),
    ]);
    return {
      folder: folderResult.ok ? folderResult.data : null,
      codespaces: codespacesResult.ok ? codespacesResult.data.items : [],
    };
  },
  component: FolderOverviewPage,
});

function FolderOverviewPage(): React.JSX.Element {
  const { folderId } = Route.useParams();
  const loaderData = Route.useLoaderData() as
    | { folder: FolderData | null; codespaces: CodespaceListItem[] }
    | undefined;

  const [folder, setFolder] = useState<FolderData | null>(
    () => (loaderData?.folder as FolderData) ?? null
  );
  const [codespaces, setCodespaces] = useState<CodespaceListItem[]>(
    () => (loaderData?.codespaces as CodespaceListItem[]) ?? []
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.folder);
  const [searchQuery, setSearchQuery] = useState('');

  useWatchEffect(() => {
    if (loaderData?.folder) return;
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [folderResult, codespacesResult] = await Promise.all([
          apiClient.projectFolders.get(folderId),
          apiClient.projectFolders.listCodespaces(folderId),
        ]);
        if (folderResult.ok) setFolder(folderResult.data as FolderData);
        if (codespacesResult.ok) setCodespaces(codespacesResult.data.items);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [folderId, loaderData]);

  const filteredCodespaces = useMemo(() => {
    if (!searchQuery.trim()) return codespaces;
    const query = searchQuery.toLowerCase();
    return codespaces.filter(
      (cs) => cs.name.toLowerCase().includes(query) || cs.path.toLowerCase().includes(query)
    );
  }, [codespaces, searchQuery]);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Folders' }, { label: 'Loading...' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Spinner className="h-5 w-5 animate-spin text-fg-muted" />
        </div>
      </LayoutShell>
    );
  }

  if (!folder) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Folders' }, { label: 'Not Found' }]}>
        <div className="p-6 text-sm text-fg-muted">Folder not found.</div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Folders' }, { label: folder.name }]}
      actions={
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search codespaces..."
            className="w-48 rounded-md border border-border bg-surface py-1.5 pl-9 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        {/* Folder header */}
        <div className="flex items-center gap-3">
          <Folder className="h-6 w-6 text-fg-muted" weight="duotone" />
          <div>
            <h1 className="text-2xl font-semibold text-fg">{folder.name}</h1>
            {folder.description && (
              <p className="text-sm text-fg-muted mt-0.5">{folder.description}</p>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-4 text-sm text-fg-muted">
          <span>
            {codespaces.length} codespace{codespaces.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Codespace list */}
        {filteredCodespaces.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="No codespaces in this folder"
            subtitle="Assign codespaces to this folder from their settings page."
          />
        ) : (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {filteredCodespaces.map((cs) => (
              <Link
                key={cs.id}
                to="/codespaces/$codespaceId"
                params={{ codespaceId: cs.id }}
                className="rounded-lg border border-border bg-surface p-4 transition hover:border-fg-subtle"
              >
                <p className="text-sm font-semibold text-fg truncate">{cs.name}</p>
                <p className="text-xs text-fg-muted font-mono truncate mt-1">{cs.path}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </LayoutShell>
  );
}
