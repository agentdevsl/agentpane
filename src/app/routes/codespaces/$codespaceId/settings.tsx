import { ArrowLeft } from '@phosphor-icons/react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import React, { Suspense, useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { useTimeout } from '@/app/hooks/use-timeout';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

// Lazy-load heavy settings component (FC-012)
const ProjectSettings = React.lazy(() =>
  import('@/app/components/features/project-settings').then((m) => ({
    default: m.ProjectSettings,
  }))
);

import { useCodespaceData } from '@/app/providers/codespace-context';
import type { Codespace, CodespaceConfig } from '@/db/schema';
import { apiClient } from '@/lib/api/client';

export const Route = createFileRoute('/codespaces/$codespaceId/settings')({
  loader: async ({ params }: { params: { codespaceId: string } }) => {
    const result = await apiClient.codespaces.get(params.codespaceId);
    return { codespace: result.ok ? result.data : null };
  },
  component: CodespaceSettingsPage,
});

function CodespaceSettingsPage(): React.JSX.Element {
  const { codespaceId } = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const { refreshCodespaces } = useCodespaceData();
  const loaderData = Route.useLoaderData() as { codespace: Codespace | null } | undefined;
  const [codespace, setCodespace] = useState<Codespace | null>(
    () => (loaderData?.codespace as unknown as Codespace) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.codespace);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleBack = () => {
    // Try to go back in history, fall back to codespace page
    if (window.history.length > 1) {
      router.history.back();
    } else {
      void navigate({ to: '/codespaces/$codespaceId', params: { codespaceId } });
    }
  };

  // Auto-dismiss saved status
  useTimeout(() => setSaveStatus('idle'), saveStatus === 'saved' ? 2000 : null);

  // Fetch codespace from API on mount
  useWatchEffect(() => {
    if (loaderData?.codespace) return;
    const fetchCodespace = async () => {
      const result = await apiClient.codespaces.get(codespaceId);
      if (result.ok) {
        setCodespace(result.data as unknown as Codespace);
      }
      setIsLoading(false);
    };
    void fetchCodespace();
  }, [codespaceId, loaderData]);

  const handleSave = async (input: {
    name?: string;
    description?: string;
    maxConcurrentAgents?: number;
    config?: Partial<CodespaceConfig>;
    projectFolderId?: string;
  }): Promise<void> => {
    setSaveStatus('saving');
    try {
      const result = await apiClient.codespaces.update(codespaceId, {
        name: input.name,
        description: input.description,
        maxConcurrentAgents: input.maxConcurrentAgents,
        config: input.config as Record<string, unknown>,
        projectFolderId: input.projectFolderId || undefined,
      });

      if (result.ok) {
        setCodespace(result.data as unknown as Codespace);
        setSaveStatus('saved');
        // Refresh the codespace list so sidebar/folder counts update immediately
        void refreshCodespaces();
      } else {
        setSaveStatus('error');
        console.error('Failed to save codespace settings:', result.error);
      }
    } catch (error) {
      setSaveStatus('error');
      console.error('Error saving codespace settings:', error);
    }
  };

  const handleDelete = async (options: { deleteFiles: boolean }): Promise<void> => {
    const result = await apiClient.codespaces.delete(codespaceId, options);
    if (result.ok) {
      void navigate({ to: '/codespaces' });
    } else {
      throw new Error(result.error.message);
    }
  };

  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Codespaces', to: '/codespaces' },
          { label: 'Loading...' },
          { label: 'Settings' },
        ]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading codespace settings...</div>
        </div>
      </LayoutShell>
    );
  }

  if (!codespace) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Codespaces', to: '/codespaces' }, { label: 'Not Found' }]}
      >
        <div className="p-6 text-sm text-fg-muted">Codespace not found.</div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      codespaceId={codespace.id}
      codespaceName={codespace.name}
      codespacePath={codespace.path}
      breadcrumbs={[
        { label: 'Codespaces', to: '/codespaces' },
        { label: codespace.name, to: `/codespaces/${codespace.id}` },
        { label: 'Settings' },
      ]}
    >
      <div className="h-full overflow-y-auto">
        <div className="p-6 max-w-4xl mx-auto pb-12" data-testid="codespace-settings-page">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg mb-4 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="mb-6">
            <h1 className="text-2xl font-bold text-fg">Codespace Settings</h1>
            <p className="text-sm text-fg-muted mt-1">
              Configure codespace behavior and agent defaults for {codespace.name}
            </p>
          </div>

          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12 text-fg-muted">
                Loading settings...
              </div>
            }
          >
            <ProjectSettings
              project={codespace}
              onSave={handleSave}
              onDelete={handleDelete}
              saveStatus={saveStatus}
            />
          </Suspense>
        </div>
      </div>
    </LayoutShell>
  );
}
