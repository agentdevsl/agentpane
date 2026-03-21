import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { SessionHistory } from '@/app/components/features/session-history';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';

// Session data shape from API
interface ApiSession {
  id: string;
  projectId: string;
  taskId?: string | null;
  agentId?: string | null;
  title?: string | null;
  url: string;
  status: string;
  createdAt?: string;
  closedAt?: string | null;
}

// Codespace data shape
interface Codespace {
  id: string;
  name: string;
}

export const Route = createFileRoute('/sessions/')({
  loader: async () => {
    const [sessionsResult, codespacesResult] = await Promise.all([
      apiClient.sessions.list(),
      apiClient.codespaces.list(),
    ]);
    return {
      sessions: sessionsResult.ok
        ? Array.isArray(sessionsResult.data)
          ? sessionsResult.data
          : []
        : [],
      projects: codespacesResult.ok
        ? Array.isArray(codespacesResult.data)
          ? codespacesResult.data
          : ((codespacesResult.data as { items?: Codespace[] }).items ?? [])
        : [],
    };
  },
  component: SessionsPage,
});

function SessionsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const loaderData = Route.useLoaderData() as
    | { sessions: ApiSession[]; projects: Codespace[] }
    | undefined;
  const [sessions, setSessions] = useState<ApiSession[]>(
    () => (loaderData?.sessions as ApiSession[]) ?? []
  );
  const [projects, setProjects] = useState<Codespace[]>(() => loaderData?.projects ?? []);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!loaderData?.sessions);

  // Fetch sessions and codespaces from API on mount
  useMountEffect(() => {
    if (loaderData?.sessions) return;
    const fetchData = async () => {
      try {
        const [sessionsResult, codespacesResult] = await Promise.all([
          apiClient.sessions.list(),
          apiClient.codespaces.list(),
        ]);

        if (sessionsResult.ok && sessionsResult.data) {
          const sessionsData = Array.isArray(sessionsResult.data) ? sessionsResult.data : [];
          setSessions(sessionsData as ApiSession[]);
        }

        if (codespacesResult.ok && codespacesResult.data) {
          const codespacesData = Array.isArray(codespacesResult.data)
            ? codespacesResult.data
            : ((codespacesResult.data as { items?: Codespace[] }).items ?? []);
          setProjects(codespacesData as Codespace[]);
        }
      } catch {
        // API may not be ready yet
      }
      setIsLoading(false);
    };
    fetchData();
  });

  // Filter sessions by selected codespace
  const filteredSessions = useMemo(() => {
    if (!selectedProjectId) return sessions;
    return sessions.filter((s) => s.projectId === selectedProjectId);
  }, [sessions, selectedProjectId]);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Sessions' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading sessions...</div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell breadcrumbs={[{ label: 'Sessions' }]}>
      <div className="flex h-full w-full flex-col">
        <SessionHistory
          sessions={filteredSessions}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onProjectChange={setSelectedProjectId}
          isLoading={isLoading}
          onOpen={(sessionId) => navigate({ to: '/sessions/$sessionId', params: { sessionId } })}
          onViewTask={(taskId, codespaceId) =>
            navigate({
              to: '/codespaces/$codespaceId/tasks/$taskId',
              params: { codespaceId, taskId },
            })
          }
        />
      </div>
    </LayoutShell>
  );
}
