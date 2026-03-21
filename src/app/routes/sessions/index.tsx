import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { SessionHistory } from '@/app/components/features/session-history';
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

// Project data shape
interface Project {
  id: string;
  name: string;
}

export const Route = createFileRoute('/sessions/')({
  loader: async () => {
    const [sessionsResult, projectsResult] = await Promise.all([
      apiClient.sessions.list(),
      apiClient.projects.list(),
    ]);
    return {
      sessions: sessionsResult.ok
        ? Array.isArray(sessionsResult.data)
          ? sessionsResult.data
          : []
        : [],
      projects: projectsResult.ok
        ? Array.isArray(projectsResult.data)
          ? projectsResult.data
          : ((projectsResult.data as { items?: Project[] }).items ?? [])
        : [],
    };
  },
  component: SessionsPage,
});

function SessionsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const loaderData = Route.useLoaderData() as
    | { sessions: ApiSession[]; projects: Project[] }
    | undefined;
  const [sessions, setSessions] = useState<ApiSession[]>(
    () => (loaderData?.sessions as ApiSession[]) ?? []
  );
  const [projects, setProjects] = useState<Project[]>(() => loaderData?.projects ?? []);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!loaderData?.sessions);

  // Fetch sessions and projects from API on mount
  useEffect(() => {
    if (loaderData?.sessions) return;
    const fetchData = async () => {
      try {
        const [sessionsResult, projectsResult] = await Promise.all([
          apiClient.sessions.list(),
          apiClient.projects.list(),
        ]);

        if (sessionsResult.ok && sessionsResult.data) {
          const sessionsData = Array.isArray(sessionsResult.data) ? sessionsResult.data : [];
          setSessions(sessionsData as ApiSession[]);
        }

        if (projectsResult.ok && projectsResult.data) {
          const projectsData = Array.isArray(projectsResult.data)
            ? projectsResult.data
            : ((projectsResult.data as { items?: Project[] }).items ?? []);
          setProjects(projectsData as Project[]);
        }
      } catch {
        // API may not be ready yet
      }
      setIsLoading(false);
    };
    fetchData();
  }, [loaderData]);

  // Filter sessions by selected project
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
          onViewTask={(taskId, projectId) =>
            navigate({ to: '/projects/$projectId/tasks/$taskId', params: { projectId, taskId } })
          }
        />
      </div>
    </LayoutShell>
  );
}
