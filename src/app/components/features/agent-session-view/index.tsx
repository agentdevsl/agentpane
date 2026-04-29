import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

const AgentTopology = lazy(() =>
  import('@/app/components/features/agent-topology').then((m) => ({ default: m.AgentTopology }))
);

import { ErrorState } from '@/app/components/features/error-state';
import { Skeleton } from '@/app/components/ui/skeleton';
import { StreamReconnectBanner } from '@/app/components/ui/stream-reconnect-banner';
import { TooltipProvider } from '@/app/components/ui/tooltip';
import { TruncationBanner } from '@/app/components/ui/truncation-banner';
import { usePresence } from '@/app/hooks/use-presence';
import { useSession } from '@/app/hooks/use-session';
import { cn } from '@/lib/utils/cn';
import { type ActivityItem, type ActivityItemType, ActivitySidebar } from './activity-sidebar';
import { type AgentStatus, HeaderBar } from './header-bar';
import { InputArea } from './input-area';
import { PresenceBar } from './presence-bar';
import { StreamPanel } from './stream-panel';
import { useStreamParser } from './use-stream-parser';

type SessionTab = 'stream' | 'topology';

export interface AgentSessionViewProps {
  sessionId: string;
  agentId: string;
  userId: string;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
  onSendInput?: (input: string) => Promise<void>;
  onSessionEnd?: () => void;
  onError?: (error: Error) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Map session agent state to our status type
function mapAgentStatus(status: string | undefined): AgentStatus {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    case 'completed':
      return 'completed';
    default:
      return 'idle';
  }
}

// Loading skeleton for initial load
function SessionLoadingSkeleton(): React.JSX.Element {
  return (
    <div
      className="grid min-h-screen grid-cols-[1fr_320px] grid-rows-[auto_auto_1fr_auto] gap-0 bg-canvas"
      data-testid="session-skeleton"
    >
      {/* Header skeleton */}
      <div className="col-span-full border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="space-y-1">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      </div>

      {/* Presence bar skeleton */}
      <div className="col-span-full border-b border-border bg-surface-subtle px-6 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-8" />
            <div className="flex -space-x-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-8 w-48" />
        </div>
      </div>

      {/* Stream panel skeleton */}
      <div className="m-4 mr-2 rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-2">
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="p-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>

      {/* Activity sidebar skeleton */}
      <aside className="row-span-2 border-l border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="p-4 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-1 flex-1">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Input area skeleton */}
      <div className="border-t border-border bg-canvas p-4 pr-2">
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    </div>
  );
}

export function AgentSessionView({
  sessionId,
  agentId,
  userId,
  onPause,
  onResume,
  onStop,
  onSendInput,
  onSessionEnd,
  onError,
}: AgentSessionViewProps): React.JSX.Element {
  const { state, connectionState, terminalDisconnect, leave } = useSession(sessionId, userId);
  const isStreaming = state.agentState?.status === 'running';
  const { users } = usePresence(sessionId, userId);
  const [activeTab, setActiveTab] = useState<SessionTab>('stream');

  // Parse stream content into display lines
  const streamLines = useStreamParser(state.chunks, state.toolCalls, state.terminal);

  // Track activity items
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const prevUsersRef = useRef<string[]>([]);
  const prevStatusRef = useRef<string | undefined>(undefined);

  // Track loading state
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const startTimeRef = useRef<number | undefined>(undefined);

  // Get share URL
  const shareUrl = useMemo(
    () => `${typeof window !== 'undefined' ? window.location.origin : ''}/sessions/${sessionId}`,
    [sessionId]
  );

  // Map agent status
  const agentStatus = mapAgentStatus(state.agentState?.status);

  // Track start time
  useWatchEffect(() => {
    if (agentStatus === 'running' && !startTimeRef.current) {
      startTimeRef.current = Date.now();
    }
    if (agentStatus === 'completed' || agentStatus === 'error') {
      startTimeRef.current = undefined;
    }
  }, [agentStatus]);

  // Mark as loaded after first state update
  const hasData = state.chunks.length > 0 || state.agentState !== null;
  useWatchEffect(() => {
    if (hasData) {
      setIsLoading(false);
      return;
    }
    // Timeout after 5 seconds
    const timeout = setTimeout(() => setIsLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, [hasData]);

  // Track user joins/leaves
  useWatchEffect(() => {
    const prevUserIds = new Set(prevUsersRef.current);
    const currentUserIds = new Set(users.map((u) => u.userId));

    // New joins
    for (const user of users) {
      if (!prevUserIds.has(user.userId) && user.userId !== userId) {
        setActivityItems((prev) => [
          {
            id: generateId(),
            type: 'join' as ActivityItemType,
            userId: user.userId,
            displayName: user.userId,
            message: 'joined the session',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      }
    }

    // Leaves
    for (const prevUserId of prevUsersRef.current) {
      if (!currentUserIds.has(prevUserId) && prevUserId !== userId) {
        setActivityItems((prev) => [
          {
            id: generateId(),
            type: 'leave' as ActivityItemType,
            userId: prevUserId,
            displayName: prevUserId,
            message: 'left the session',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      }
    }

    prevUsersRef.current = users.map((u) => u.userId);
  }, [users, userId]);

  // Track agent state changes
  useWatchEffect(() => {
    const currentStatus = state.agentState?.status;
    if (currentStatus && currentStatus !== prevStatusRef.current) {
      const statusMessages: Record<string, { type: ActivityItemType; message: string } | null> = {
        idle: null,
        starting: { type: 'start', message: 'Agent starting...' },
        running: { type: 'start', message: 'Agent is running' },
        paused: { type: 'pause', message: 'Agent paused' },
        error: { type: 'error', message: 'Agent encountered an error' },
        completed: { type: 'complete', message: 'Agent completed successfully' },
      };

      const statusInfo = statusMessages[currentStatus];
      if (statusInfo) {
        setActivityItems((prev) => [
          {
            id: generateId(),
            type: statusInfo.type,
            message: statusInfo.message,
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      }

      prevStatusRef.current = currentStatus;
    }
  }, [state.agentState?.status]);

  // Handle errors
  useWatchEffect(() => {
    if (error) {
      onError?.(error);
    }
  }, [error, onError]);

  // Handlers
  const handlePause = useCallback(async () => {
    try {
      await onPause();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to pause'));
    }
  }, [onPause]);

  const handleResume = useCallback(async () => {
    try {
      await onResume();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to resume'));
    }
  }, [onResume]);

  const handleStop = useCallback(async () => {
    const confirmed = window.confirm('Stop this session?');
    if (!confirmed) {
      return;
    }
    try {
      await onStop();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to stop'));
    }
  }, [onStop]);

  const handleSendInput = useCallback(
    async (input: string) => {
      if (onSendInput) {
        try {
          await onSendInput(input);
        } catch (err) {
          setError(err instanceof Error ? err : new Error('Failed to send input'));
        }
      }
    },
    [onSendInput]
  );

  const handleLeaveSession = useCallback(async () => {
    await leave();
    onSessionEnd?.();
  }, [leave, onSessionEnd]);

  const handleEndSession = useCallback(async () => {
    await handleStop();
    await leave();
    onSessionEnd?.();
  }, [handleStop, leave, onSessionEnd]);

  // F05-21: manual reconnect when the streams client surfaces a terminal
  // disconnect. Reloading the route re-creates the subscription with a fresh
  // reconnect budget. A future iteration can rebuild the subscription in
  // place rather than reloading the page.
  const handleManualReconnect = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  // Get viewer colors for stream panel (memoized to avoid new array refs every render)
  const viewerColors = useMemo<string[]>(
    () =>
      users.slice(0, 3).map((u) => {
        const colors = [
          'bg-red-500',
          'bg-blue-500',
          'bg-green-500',
          'bg-yellow-500',
          'bg-purple-500',
        ];
        let hash = 0;
        const id = u.userId || '';
        for (let i = 0; i < id.length; i++) {
          hash = id.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length] ?? 'bg-blue-500';
      }),
    [users]
  );

  // Loading state
  if (isLoading) {
    return <SessionLoadingSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-canvas p-8"
        data-testid="error-state"
      >
        <ErrorState
          title="Session Error"
          description={error.message}
          onRetry={() => {
            setError(null);
            setIsLoading(true);
          }}
        />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="grid min-h-screen grid-cols-[1fr_320px] grid-rows-[auto_auto_1fr_auto] gap-0 bg-canvas"
        data-testid="session-view"
      >
        {/* Header bar - spans both columns */}
        <div className="col-span-full">
          <HeaderBar
            sessionId={sessionId}
            status={agentStatus}
            startTime={startTimeRef.current}
            onPause={handlePause}
            onResume={handleResume}
            onStop={handleStop}
          />
        </div>

        {/* Presence bar - spans both columns */}
        <div className="col-span-full">
          <PresenceBar users={users} shareUrl={shareUrl} />
        </div>

        {/* F05-21: stream-status banners. Truncation banner shows when the
            client-side chunk buffer drops history; reconnect banner shows
            when the durable-streams reconnect budget is exhausted. Both
            primitives existed previously but had no caller — wiring them
            here makes them user-visible. */}
        {state.truncated ? (
          <div className="col-span-full">
            <TruncationBanner truncatedCount={state.truncatedCount} />
          </div>
        ) : null}
        {terminalDisconnect ? (
          <div className="col-span-full">
            <StreamReconnectBanner onReconnect={handleManualReconnect} />
          </div>
        ) : null}

        {/* Main content - left column with tabs */}
        <div className="flex flex-col min-h-0">
          {/* FC-015: Tab bar with ARIA tablist/tab roles */}
          <div
            className="flex border-b border-border bg-surface-subtle px-2"
            role="tablist"
            aria-label="Session views"
          >
            <button
              type="button"
              role="tab"
              id="tab-stream"
              aria-selected={activeTab === 'stream'}
              aria-controls="tabpanel-stream"
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors',
                activeTab === 'stream'
                  ? 'border-b-2 border-accent text-fg'
                  : 'text-fg-muted hover:text-fg'
              )}
              onClick={() => setActiveTab('stream')}
            >
              Stream
            </button>
            <button
              type="button"
              role="tab"
              id="tab-topology"
              aria-selected={activeTab === 'topology'}
              aria-controls="tabpanel-topology"
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors',
                activeTab === 'topology'
                  ? 'border-b-2 border-accent text-fg'
                  : 'text-fg-muted hover:text-fg'
              )}
              onClick={() => setActiveTab('topology')}
            >
              Topology
            </button>
          </div>

          {/* Tab content */}
          {/* FC-015: aria-live="polite" on streaming container for screen readers */}
          {activeTab === 'stream' ? (
            <div
              role="tabpanel"
              id="tabpanel-stream"
              aria-labelledby="tab-stream"
              aria-live="polite"
            >
              <StreamPanel
                lines={streamLines}
                isStreaming={isStreaming}
                connectionState={connectionState}
                viewerColors={viewerColors}
              />
            </div>
          ) : (
            <div
              className="flex-1 min-h-0"
              role="tabpanel"
              id="tabpanel-topology"
              aria-labelledby="tab-topology"
            >
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center text-sm text-fg-muted">
                    Loading topology...
                  </div>
                }
              >
                <AgentTopology />
              </Suspense>
            </div>
          )}
        </div>

        {/* Activity sidebar - right column, spans into input row */}
        <div className="row-span-2">
          <ActivitySidebar
            items={activityItems}
            onLeaveSession={handleLeaveSession}
            onEndSession={handleEndSession}
            canEndSession={true}
            sessionMetadata={{
              agentName: agentId || 'Agent',
              startedAt: startTimeRef.current,
            }}
          />
        </div>

        {/* Input area - left column only */}
        <InputArea
          onSubmit={handleSendInput}
          disabled={agentStatus !== 'running'}
          placeholder="Send a message or command to the agent..."
        />
      </div>
    </TooltipProvider>
  );
}

// Re-export types and components for external use
export type { ActivityItem, ActivityItemType } from './activity-sidebar';
export {
  ActivitySidebar,
  activityIcons,
  activityIconVariants,
  formatRelativeTime,
} from './activity-sidebar';

export type { AgentStatus } from './header-bar';
export { HeaderBar } from './header-bar';

export { InputArea } from './input-area';

export { Avatar, getInitials, getUserGradient, PresenceBar } from './presence-bar';

export { StreamCursor, StreamLine as StreamLineComponent } from './stream-line';

export { StreamPanel } from './stream-panel';

export type { StreamLine, StreamLineType } from './use-stream-parser';
export { groupConsecutiveLines, useStreamParser } from './use-stream-parser';
