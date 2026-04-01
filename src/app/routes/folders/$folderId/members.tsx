import { Spinner, UserCircle, UsersThree } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';

type FolderData = {
  id: string;
  name: string;
};

type FolderMember = {
  id: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  email?: string;
  name?: string;
};

export const Route = createFileRoute('/folders/$folderId/members')({
  loader: async ({ params }: { params: { folderId: string } }) => {
    const folderResult = await apiClient.projectFolders.get(params.folderId);
    return {
      folder: folderResult.ok ? folderResult.data : null,
      // Members endpoint may not exist yet -- return empty array
      members: [],
    };
  },
  component: FolderMembersPage,
});

function FolderMembersPage(): React.JSX.Element {
  const { folderId } = Route.useParams();
  const loaderData = Route.useLoaderData() as
    | { folder: FolderData | null; members: FolderMember[] }
    | undefined;

  const [folder, setFolder] = useState<FolderData | null>(
    () => (loaderData?.folder as FolderData) ?? null
  );
  const [members] = useState<FolderMember[]>(() => (loaderData?.members as FolderMember[]) ?? []);
  const [isLoading, setIsLoading] = useState(!loaderData?.folder);

  useWatchEffect(() => {
    if (loaderData?.folder) return;
    const fetchFolder = async () => {
      setIsLoading(true);
      try {
        const result = await apiClient.projectFolders.get(folderId);
        if (result.ok) setFolder(result.data as FolderData);
      } finally {
        setIsLoading(false);
      }
    };
    void fetchFolder();
  }, [folderId, loaderData]);

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Folders' }, { label: 'Loading...' }, { label: 'Members' }]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <Spinner className="h-5 w-5 animate-spin text-fg-muted" />
        </div>
      </LayoutShell>
    );
  }

  if (!folder) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Folders' }, { label: 'Not Found' }, { label: 'Members' }]}
      >
        <div className="p-6 text-sm text-fg-muted">Folder not found.</div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[
        { label: 'Folders' },
        { label: folder.name, to: `/folders/${folderId}` },
        { label: 'Members' },
      ]}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
        <div className="flex items-center gap-3">
          <UsersThree className="h-6 w-6 text-fg-muted" weight="duotone" />
          <div>
            <h1 className="text-2xl font-semibold text-fg">Folder Members</h1>
            <p className="text-sm text-fg-muted mt-0.5">Manage who has access to {folder.name}</p>
          </div>
        </div>

        {members.length === 0 ? (
          <EmptyState
            icon={UserCircle}
            title="No members yet"
            subtitle="Folder member management will be available in a future update."
          />
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <UserCircle className="h-8 w-8 text-fg-muted" />
                  <div>
                    <p className="text-sm font-medium text-fg">
                      {member.name ?? member.email ?? member.userId}
                    </p>
                    {member.email && <p className="text-xs text-fg-muted">{member.email}</p>}
                  </div>
                </div>
                <span className="text-xs font-medium text-fg-muted uppercase tracking-wide px-2 py-1 bg-surface-subtle rounded">
                  {member.role}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </LayoutShell>
  );
}
