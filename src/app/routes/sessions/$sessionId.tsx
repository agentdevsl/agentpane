import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentSessionView } from '@/app/components/features/agent-session-view';
import { ContainerAgentPanel } from '@/app/components/features/container-agent-panel';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { apiClient } from '@/lib/api/client';

// Session type for client-side display
type ClientSession = {
  id: string;
  agentId?: string | null;
  taskId?: string | null;
  title?: string | null;
  status: string;
  sandboxProvider?: string | null;
};

/**
 * Detect if this is a container-agent session.
 * Container-agent sessions use a sandbox provider (docker or kubernetes),
 * or have taskId but no agentId (legacy detection).
 */
function isContainerAgentSession(session: ClientSession): boolean {
  if (session.sandboxProvider === 'docker' || session.sandboxProvider === 'kubernetes') {
    return true;
  }
  return session.agentId === null && session.taskId !== null;
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
});

function SessionPage(): React.JSX.Element {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<ClientSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPlanActionPending, setIsPlanActionPending] = useState(false);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = 'current-user';

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const showTemporaryError = useCallback((message: string) => {
    // Clear any existing timeout to avoid stale clears
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }
    setActionError(message);
    errorTimeoutRef.current = setTimeout(() => {
      setActionError(null);
      errorTimeoutRef.current = null;
    }, 5000);
  }, []);

  const handleApprovePlan = useCallback(async () => {
    if (!session?.taskId) return;
    setIsPlanActionPending(true);
    try {
      const result = await apiClient.tasks.approvePlan(session.taskId);
      if (!result.ok) {
        showTemporaryError('Failed to approve plan');
      }
      // Execution phase starts -- session stream will update automatically
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SessionPage] Failed to approve plan:', error);
      showTemporaryError(`Failed to approve plan: ${message}`);
    } finally {
      setIsPlanActionPending(false);
    }
  }, [session?.taskId, showTemporaryError]);

  const handleRejectPlan = useCallback(async () => {
    if (!session?.taskId) return;
    setIsPlanActionPending(true);
    try {
      const result = await apiClient.tasks.rejectPlan(session.taskId);
      if (!result.ok) {
        showTemporaryError('Failed to reject plan');
        return;
      }
      // Navigate back to projects list since task is now in backlog
      navigate({ to: '/' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SessionPage] Failed to reject plan:', error);
      showTemporaryError(`Failed to reject plan: ${message}`);
    } finally {
      setIsPlanActionPending(false);
    }
  }, [session?.taskId, navigate, showTemporaryError]);

  // Fetch session from API on mount, resolving sandboxProvider from settings if missing
  useEffect(() => {
    const fetchSession = async () => {
      setIsLoading(true);
      setError(null);
      const result = await apiClient.sessions.get(sessionId);
      if (result.ok) {
        const data = result.data as ClientSession;
        // Backfill sandboxProvider from global sandbox defaults when the session record lacks it
        if (!data.sandboxProvider && data.agentId === null && data.taskId !== null) {
          try {
            const settingsResult = await apiClient.settings.get(['sandbox.defaults']);
            if (settingsResult.ok) {
              const defaults = settingsResult.data.settings['sandbox.defaults'] as
                | { provider?: string }
                | undefined;
              if (defaults?.provider) {
                data.sandboxProvider = defaults.provider === 'kubernetes' ? 'kubernetes' : 'docker';
              }
            }
          } catch {
            // Non-critical — badge just won't show
          }
        }
        setSession(data);
      } else {
        setError({ message: result.error.message });
      }
      setIsLoading(false);
    };
    fetchSession();
  }, [sessionId]);

  // Stable callbacks for agent actions (must be declared before early returns)
  const handlePause = useCallback(async () => {
    if (session?.agentId) {
      // TODO: Add API endpoint for agent pause
      try {
        await fetch(`/api/agents/${session.agentId}/pause`, { method: 'POST' });
      } catch {
        showTemporaryError('Failed to pause agent');
      }
    }
  }, [session?.agentId, showTemporaryError]);

  const handleResume = useCallback(async () => {
    if (session?.agentId) {
      // TODO: Add API endpoint for agent resume
      try {
        await fetch(`/api/agents/${session.agentId}/resume`, { method: 'POST' });
      } catch {
        showTemporaryError('Failed to resume agent');
      }
    }
  }, [session?.agentId, showTemporaryError]);

  const handleStop = useCallback(async () => {
    if (session?.agentId) {
      // TODO: Add API endpoint for agent stop
      try {
        await fetch(`/api/agents/${session.agentId}/stop`, { method: 'POST' });
      } catch {
        showTemporaryError('Failed to stop agent');
      }
    }
  }, [session?.agentId, showTemporaryError]);

  const handleContainerStop = useCallback(async () => {
    if (session?.taskId) {
      try {
        await fetch(`/api/tasks/${session.taskId}/stop-agent`, { method: 'POST' });
      } catch {
        showTemporaryError('Failed to stop agent');
      }
    }
  }, [session?.taskId, showTemporaryError]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-sm text-fg-muted">Loading session...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <EmptyState
          preset="error"
          title="Failed to load session"
          subtitle={error.message}
          action={{
            label: 'Try again',
            onClick: () => {
              void (async () => {
                setIsLoading(true);
                setError(null);
                const result = await apiClient.sessions.get(sessionId);
                if (result.ok) {
                  setSession(result.data as ClientSession);
                } else {
                  setError({ message: result.error.message });
                }
                setIsLoading(false);
              })();
            },
          }}
        />
      </div>
    );
  }

  if (!session) {
    return <div className="p-6 text-sm text-fg-muted">Session not found.</div>;
  }

  // Render container-agent session view
  if (isContainerAgentSession(session)) {
    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Sessions', to: '/sessions' },
          { label: session.title ?? session.id },
        ]}
      >
        <div className="relative flex flex-col h-full min-h-0">
          {actionError && (
            <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-md border border-danger bg-danger/10 px-4 py-2 text-sm text-danger">
              {actionError}
            </div>
          )}
          <ContainerAgentPanel
            sessionId={session.id}
            sandboxProvider={session.sandboxProvider ?? undefined}
            onStop={handleContainerStop}
            onApprovePlan={() => void handleApprovePlan()}
            onRejectPlan={() => void handleRejectPlan()}
            isPlanActionPending={isPlanActionPending}
          />
        </div>
      </LayoutShell>
    );
  }

  // Render legacy agent session view
  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Sessions', to: '/sessions' }, { label: session.title ?? session.id }]}
    >
      <div className="relative h-full">
        {actionError && (
          <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-md border border-danger bg-danger/10 px-4 py-2 text-sm text-danger">
            {actionError}
          </div>
        )}
        <AgentSessionView
          sessionId={session.id}
          agentId={session.agentId ?? ''}
          userId={userId}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
        />
      </div>
    </LayoutShell>
  );
}
