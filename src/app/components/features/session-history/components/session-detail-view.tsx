import {
  ArrowClockwise,
  ArrowSquareOut,
  Calendar,
  ChatCircle,
  CheckCircle,
  Clock,
  Cube,
  CurrencyDollar,
  Folder,
  GitBranch,
  Play,
  Trash,
  Wrench,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { AgentTopology } from '@/app/components/features/agent-topology';
import { Button } from '@/app/components/ui/button';
import { ExecutionBadge } from '@/app/components/ui/execution-badge';
import { Skeleton, SkeletonText } from '@/app/components/ui/skeleton';
import type { SessionStatus } from '@/db/schema';
import { buildTopologyFromEvents, type TopologyEvent } from '@/lib/topology/build-from-events';
import type { TopologyGraph, TopologyNode } from '@/lib/topology/types';
import { cn } from '@/lib/utils/cn';
import { useSessionEvents } from '../hooks/use-session-events';
import type { SessionDetailViewProps } from '../types';
import { SESSION_STATUS_COLORS } from '../types';
import { formatDuration, formatTimeOfDay } from '../utils/format-duration';
import { ExportDropdown } from './export-dropdown';
import { SessionSummary } from './session-summary';
import { StreamViewer } from './stream-viewer';
import { ToolCallsFullView } from './tool-calls-full-view';

function mapSessionStatusToTopologyStatus(session: {
  status: SessionStatus;
  closedAt: string | null;
}): TopologyNode['status'] {
  switch (session.status) {
    case 'active':
      return session.closedAt ? 'completed' : 'running';
    case 'closed':
    case 'closing':
      return 'completed';
    case 'error':
      return 'failed';
    case 'paused':
      return 'blocked';
    default:
      return 'queued';
  }
}

/** Default max turns for progress calculation (matches agent-execution default) */
const DEFAULT_MAX_TURNS = 50;

/** Active view tab type */
type ViewTab = 'replay' | 'tools' | 'topology';

export function SessionDetailView({
  session,
  isLoading = false,
  onExport,
  onDelete,
  onRefresh,
  onViewTask,
}: SessionDetailViewProps): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewTab>('replay');
  const { entries, toolCalls, toolCallStats, isLoading: eventsLoading } = useSessionEvents(session);

  // Build topology from historical session events (same approach as ContainerAgentPanel's TopologyTab).
  // This reconstructs subagent nodes from topology:agent_spawned events rather than showing a
  // single hardcoded orchestrator node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: granular deps intentional to avoid recompute when unrelated session fields change; session nullability handled inside
  const rootTopologyGraph: TopologyGraph | null = useMemo(() => {
    if (!session) return null;

    // When session has events, reconstruct topology from event history
    if (session.events && session.events.length > 0) {
      const topologyEvents = session.events as TopologyEvent[];
      return buildTopologyFromEvents(topologyEvents, {
        sessionId: session.id,
        agentId: session.agentId,
        taskId: session.taskId,
        taskTitle: session.taskTitle ?? session.title,
        taskColumn:
          session.status === 'closed'
            ? 'verified'
            : session.status === 'active'
              ? 'in_progress'
              : null,
        lastAgentStatus: null,
      });
    }

    // Fallback: no events available, show a single root node
    return {
      nodes: [
        {
          id: session.agentId ?? session.id,
          name: session.agentName ?? session.title ?? 'Agent',
          role: 'orchestrator',
          status: mapSessionStatusToTopologyStatus({
            status: session.status,
            closedAt: session.closedAt ?? null,
          }),
          parentId: null,
          childIds: [],
          progress:
            session.closedAt || session.status === 'closed'
              ? 100
              : session.status === 'error'
                ? 0
                : session.turnsUsed === 0
                  ? 0
                  : Math.min(95, Math.round((session.turnsUsed / DEFAULT_MAX_TURNS) * 100)),
          tokens: session.tokensUsed,
          cost: session.costUsd ?? 0,
          turns: session.turnsUsed,
          messages: session.turnsUsed,
          startedAt: new Date(session.createdAt).getTime(),
          completedAt: session.closedAt ? new Date(session.closedAt).getTime() : null,
          verified: false,
          verificationScore: 0,
          decisions: [],
        },
      ],
      edges: [],
      taskId: session.taskId ?? '',
      taskName: session.taskTitle ?? session.title ?? '',
      taskPriority: 'normal',
    };
  }, [
    session?.id,
    session?.agentId,
    session?.agentName,
    session?.title,
    session?.status,
    session?.closedAt,
    session?.turnsUsed,
    session?.tokensUsed,
    session?.costUsd,
    session?.createdAt,
    session?.taskId,
    session?.taskTitle,
    session?.events,
  ]);

  // Loading state
  if (isLoading) {
    return (
      <section
        className="flex flex-1 flex-col overflow-hidden bg-canvas"
        data-testid="session-detail-loading"
      >
        <div className="border-b border-border bg-surface p-4 md:p-6">
          <div className="mb-3 flex items-start justify-between">
            <div className="flex items-center gap-3">
              <Skeleton variant="text" width={120} height={20} />
              <Skeleton variant="text" width={60} height={16} />
              <Skeleton variant="text" width={70} height={20} className="rounded" />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            {['meta-0', 'meta-1', 'meta-2', 'meta-3', 'meta-4'].map((id) => (
              <Skeleton key={id} variant="text" width={100} height={14} />
            ))}
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
          {['stream-0', 'stream-1', 'stream-2', 'stream-3', 'stream-4'].map((id) => (
            <div key={id} className="flex gap-3 p-3">
              <Skeleton variant="text" width={60} height={16} />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width={80} height={12} />
                <SkeletonText lines={2} lineHeight={14} lastLineWidth={75} />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Empty state
  if (!session) {
    return (
      <section
        className="flex flex-1 flex-col items-center justify-center overflow-hidden bg-canvas"
        data-testid="session-detail-empty"
      >
        <Clock className="mb-4 h-12 w-12 text-fg-subtle" />
        <h3 className="mb-2 text-lg font-medium text-fg">Select a Session</h3>
        <p className="text-sm text-fg-muted">
          Choose a session from the timeline to view its details
        </p>
      </section>
    );
  }

  const statusColors = SESSION_STATUS_COLORS[session.status];
  const formattedDate = new Date(session.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Build metadata items array for consistent rendering
  const metaItems: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = [];

  if (session.codespaceName) {
    metaItems.push({
      icon: <Folder className="h-3.5 w-3.5" weight="fill" />,
      label: 'Codespace',
      value: session.codespaceName,
    });
  }

  if (session.agentName) {
    metaItems.push({
      icon: <Wrench className="h-3.5 w-3.5" />,
      label: 'Agent',
      value: session.agentName,
    });
  }

  if (session.taskId) {
    const taskId = session.taskId;
    metaItems.push({
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      label: 'Task',
      value: onViewTask ? (
        <button
          type="button"
          onClick={() => onViewTask(taskId, session.codespaceId)}
          className="inline-flex items-center gap-1 font-mono text-done underline-offset-2 hover:underline"
        >
          #{taskId.slice(0, 7)}
        </button>
      ) : (
        <span className="font-mono text-done">#{taskId.slice(0, 7)}</span>
      ),
    });
  }

  if (session.sandboxProvider) {
    metaItems.push({
      icon: <Cube className="h-3.5 w-3.5" />,
      label: 'Execution',
      value: (
        <ExecutionBadge
          sandboxProvider={session.sandboxProvider}
          sandboxContainerId={session.sandboxContainerId}
          size="full"
        />
      ),
    });
  }

  if (session.costUsd != null && session.costUsd > 0) {
    metaItems.push({
      icon: <CurrencyDollar className="h-3.5 w-3.5" />,
      label: 'Cost',
      value: `$${session.costUsd.toFixed(3)}`,
    });
  }

  metaItems.push({
    icon: <Clock className="h-3.5 w-3.5" />,
    label: 'Duration',
    value: session.duration != null ? formatDuration(session.duration) : 'In progress',
  });

  metaItems.push({
    icon: <ChatCircle className="h-3.5 w-3.5" />,
    label: 'Turns',
    value: `${session.turnsUsed}/${DEFAULT_MAX_TURNS}`,
  });

  metaItems.push({
    icon: <Calendar className="h-3.5 w-3.5" />,
    label: 'Started',
    value: `${formattedDate} at ${formatTimeOfDay(session.createdAt)}`,
  });

  metaItems.push({
    icon: <Wrench className="h-3.5 w-3.5" />,
    label: 'Tools',
    value: toolCallStats.totalCalls.toString(),
  });

  return (
    <section
      className="flex flex-1 flex-col overflow-hidden bg-canvas"
      data-testid="session-detail"
    >
      {/* Header */}
      <header className="shrink-0 border-b border-border bg-surface px-4 py-3 md:px-6 md:py-4">
        {/* Title row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-fg md:text-base">Session Replay</h2>
            <span className="font-mono text-xs text-accent">#{session.id.slice(0, 7)}</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                statusColors.badge,
                statusColors.text
              )}
            >
              <CheckCircle className="h-3 w-3" weight="fill" />
              {session.status === 'closed'
                ? 'Success'
                : session.status === 'error'
                  ? 'Failed'
                  : session.status.charAt(0).toUpperCase() + session.status.slice(1)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={`/sessions/${session.id}`}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-subtle hover:text-fg transition-colors"
              title="Open full session view"
            >
              <ArrowSquareOut className="h-3.5 w-3.5" />
              Open
            </a>
            {onRefresh ? (
              <Button variant="ghost" size="sm" onClick={onRefresh} title="Refresh session">
                <ArrowClockwise className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>

        {/* Meta info - unified row with separators */}
        <div className="mt-3 flex items-center overflow-x-auto text-xs">
          {metaItems.map((item, index) => (
            <div key={item.label} className="flex items-center">
              {index > 0 && <span className="mx-3 h-3.5 w-px bg-border/60" aria-hidden="true" />}
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="text-fg-muted">{item.icon}</span>
                <span className="text-fg-subtle">{item.label}</span>
                <span className="font-medium text-fg">{item.value}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Segmented Tab Switcher */}
        <div className="mt-4">
          <div
            className="inline-flex gap-1 rounded-lg border border-border bg-surface-subtle p-1"
            role="tablist"
            aria-label="Session view tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'replay'}
              aria-controls="session-replay-panel"
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-fast',
                activeView === 'replay'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
              )}
              onClick={() => setActiveView('replay')}
              data-testid="tab-session-replay"
            >
              <Play className="h-4 w-4" weight={activeView === 'replay' ? 'fill' : 'bold'} />
              Session Replay
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'tools'}
              aria-controls="tool-calls-panel"
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-fast',
                activeView === 'tools'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
              )}
              onClick={() => setActiveView('tools')}
              data-testid="tab-tool-calls"
            >
              <Wrench className="h-4 w-4" weight={activeView === 'tools' ? 'fill' : 'bold'} />
              Tool Calls
              {toolCalls.length > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    activeView === 'tools' ? 'bg-white/20 text-white' : 'bg-surface text-fg-muted'
                  )}
                >
                  {toolCalls.length}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'topology'}
              aria-controls="topology-panel"
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-fast',
                activeView === 'topology'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
              )}
              onClick={() => setActiveView('topology')}
              data-testid="tab-topology"
            >
              <GitBranch className="h-4 w-4" weight={activeView === 'topology' ? 'fill' : 'bold'} />
              Topology
            </button>
          </div>
        </div>
      </header>

      {/* View content based on active tab */}
      {activeView === 'replay' ? (
        <div
          id="session-replay-panel"
          role="tabpanel"
          aria-labelledby="tab-session-replay"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <StreamViewer entries={entries} isLoading={eventsLoading} />
        </div>
      ) : activeView === 'tools' ? (
        <div
          id="tool-calls-panel"
          role="tabpanel"
          aria-labelledby="tab-tool-calls"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4"
        >
          <ToolCallsFullView
            toolCalls={toolCalls}
            stats={toolCallStats}
            isLoading={eventsLoading}
          />
        </div>
      ) : (
        <div
          id="topology-panel"
          role="tabpanel"
          aria-labelledby="tab-topology"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <AgentTopology
            sessionId={
              session.status !== 'closed' && session.status !== 'error' ? session.id : undefined
            }
            initialData={rootTopologyGraph ?? undefined}
          />
        </div>
      )}

      {/* Session summary */}
      <SessionSummary
        metrics={{
          filesModified: session.filesModified,
          linesAdded: session.linesAdded,
          linesRemoved: session.linesRemoved,
          testsRun: session.testsRun,
          testsPassed: session.testsPassed,
          tokensUsed: session.tokensUsed,
          turnsUsed: session.turnsUsed,
          duration: session.duration,
          costUsd: session.costUsd ?? null,
        }}
      />

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-subtle p-3 md:p-4">
        <div className="flex items-center gap-3">
          {onExport ? <ExportDropdown onExport={onExport} /> : null}
        </div>

        <div className="flex items-center gap-3">
          {onDelete ? (
            <Button variant="ghost" size="sm" onClick={onDelete} className="text-danger">
              <Trash className="h-4 w-4" />
              Delete Session
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
