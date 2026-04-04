import {
  ArrowRight,
  Broadcast,
  CheckCircle,
  GitBranch,
  Lightning,
  WarningCircle,
} from '@phosphor-icons/react';
import React, { Suspense, useMemo, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import {
  buildTopologyFromEvents,
  extractSessionEvents,
  type TopologyEvent,
} from '@/lib/topology/build-from-events';
import type { TopologyGraph } from '@/lib/topology/types';
import { cn } from '@/lib/utils/cn';
import { TaskListSidebar } from './task-list-sidebar';

// Lazy-load heavy topology component
const AgentTopology = React.lazy(() =>
  import('@/app/components/features/agent-topology').then((m) => ({
    default: m.AgentTopology,
  }))
);

// Lazy-load audit trail panel
const AuditTrailPanel = React.lazy(() =>
  import('./audit-trail-panel').then((m) => ({
    default: m.AuditTrailPanel,
  }))
);

const COMPLETED_COLUMNS = new Set(['done', 'verified']);

// =============================================================================
// Types
// =============================================================================

interface LiveTaskViewTask {
  id: string;
  codespaceId?: string | null;
  title: string;
  description?: string | null;
  column: string;
  priority?: 'low' | 'medium' | 'high';
  agentId?: string | null;
  sessionId?: string | null;
  lastAgentStatus?: string | null;
  labels?: string[] | null;
  branch?: string | null;
  skillId?: string | null;
  skillName?: string | null;
}

interface LiveTaskViewProps {
  tasks: LiveTaskViewTask[];
  codespaceId: string;
  onTaskMove?: (taskId: string, column: string, position: number) => void;
}

// =============================================================================
// LiveTaskView Component
// =============================================================================

/**
 * Live task view — 3-column layout with task list, agent topology, and audit trail.
 * Alternative to the Kanban board for monitoring active agent work.
 */
export function LiveTaskView({
  tasks,
  codespaceId: _codespaceId,
  onTaskMove,
}: LiveTaskViewProps): React.JSX.Element {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [topologyData, setTopologyData] = useState<TopologyGraph | undefined>(undefined);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);

  const normalizedSelectedTaskId = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : null;
  }, [selectedTaskId, tasks]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === normalizedSelectedTaskId) ?? null,
    [normalizedSelectedTaskId, tasks]
  );

  // Fetch session events to build initial topology data when a task is selected
  useWatchEffect(() => {
    const sessionId = selectedTask?.sessionId;

    // Bug 2 fix: always reset when dependencies change (prevents stale data on task switch)
    setTopologyData(undefined);
    setTopologyError(null);

    if (!sessionId) return;

    let cancelled = false;

    const fetchTopologyFromEvents = async () => {
      try {
        const result = await apiClient.sessions.getEvents(sessionId, { limit: 500 });
        if (cancelled) return;

        if (!result.ok) {
          setTopologyError('Session events not found');
          return;
        }

        const events = extractSessionEvents(
          result.data as TopologyEvent[] | { data: TopologyEvent[] }
        );

        const graph = buildTopologyFromEvents(events, {
          sessionId,
          agentId: selectedTask?.agentId,
          taskId: selectedTask?.id,
          taskTitle: selectedTask?.title,
          taskColumn: selectedTask?.column,
          lastAgentStatus: selectedTask?.lastAgentStatus,
          skillId: selectedTask?.skillId ?? null,
          skillName: selectedTask?.skillName ?? null,
        });

        // Preserve task metadata from the selected task
        setTopologyData({
          ...graph,
          taskPriority: selectedTask?.priority ?? '',
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[LiveTaskView] Failed to fetch topology events:', err);
        setTopologyError(err instanceof Error ? err.message : 'Failed to load session data');
      }
    };

    void fetchTopologyFromEvents();

    return () => {
      cancelled = true;
    };
  }, [
    selectedTask?.sessionId,
    selectedTask?.id,
    selectedTask?.title,
    selectedTask?.priority,
    retryCounter,
  ]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="live-task-view">
      {/* Left: Task List Sidebar */}
      <TaskListSidebar
        tasks={tasks}
        selectedTaskId={normalizedSelectedTaskId}
        onTaskSelect={setSelectedTaskId}
        onSelectedTaskHidden={() => setSelectedTaskId(null)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Center: Agent Topology Canvas */}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 border-l border-r border-border">
        {selectedTask ? (
          <>
            {/* Task summary header with status pipeline */}
            <div className="border-b border-border-subtle bg-surface shrink-0">
              {/* Title row */}
              <div className="flex items-center gap-3 px-4 pt-3 pb-2">
                <span className="text-[13px] font-semibold text-fg truncate flex-1">
                  {selectedTask.title}
                </span>
                {selectedTask.branch && (
                  <span className="flex items-center gap-1 text-[11px] font-mono text-fg-subtle">
                    <GitBranch size={12} />
                    {selectedTask.branch}
                  </span>
                )}
              </div>

              {/* Status pipeline */}
              <TaskStatusPipeline
                currentColumn={selectedTask.column}
                taskId={selectedTask.id}
                onMove={onTaskMove}
              />
            </div>

            {/* Canvas: topology when session exists and data loaded, empty state otherwise */}
            {selectedTask.sessionId && topologyData ? (
              <div className="relative flex-1 min-h-0 h-full" key={selectedTask.sessionId}>
                <div className="absolute inset-0">
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center h-full">
                        <p className="text-sm text-fg-muted">Loading topology...</p>
                      </div>
                    }
                  >
                    <AgentTopology sessionId={selectedTask.sessionId} initialData={topologyData} />
                  </Suspense>
                </div>
              </div>
            ) : selectedTask.sessionId && topologyError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center px-6">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
                  <WarningCircle size={28} className="text-danger" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-fg">Failed to load session data</p>
                  <p className="text-xs text-fg-subtle max-w-xs">{topologyError}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setRetryCounter((c) => c + 1)}
                  className="rounded-md border border-border bg-surface-subtle px-4 py-1.5 text-xs font-medium text-fg-muted transition-all duration-150 hover:bg-surface-emphasis hover:text-fg hover:border-fg-subtle"
                >
                  Retry
                </button>
              </div>
            ) : selectedTask.sessionId && !topologyData ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-fg-muted">Loading session data...</p>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-6">
                <Broadcast size={40} className="text-fg-subtle opacity-40" />
                <p className="text-sm text-fg-muted">No agent session for this task</p>
                <p className="text-xs text-fg-subtle max-w-xs">
                  Move the task to In Progress to start an agent and see its execution flow
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-6">
            <Broadcast size={40} className="text-fg-subtle opacity-40" />
            <p className="text-sm text-fg-muted">Select a task to view details</p>
          </div>
        )}
      </div>

      {/* Right: Audit Trail Panel */}
      <Suspense fallback={null}>
        <AuditTrailPanel task={selectedTask} />
      </Suspense>
    </div>
  );
}

// =============================================================================
// TaskStatusPipeline — connected stepper with track line
// =============================================================================

const PIPELINE_STEPS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'queued', label: 'Queued' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'waiting_approval', label: 'Waiting Approval' },
  { id: 'verified', label: 'Verified' },
] as const;

function TaskStatusPipeline({
  currentColumn,
  taskId,
  onMove,
}: {
  currentColumn: string;
  taskId: string;
  onMove?: (taskId: string, column: string, position: number) => void;
}): React.JSX.Element {
  const normalizedCurrentColumn = COMPLETED_COLUMNS.has(currentColumn) ? 'verified' : currentColumn;
  const currentIndex = PIPELINE_STEPS.findIndex((c) => c.id === normalizedCurrentColumn);
  const nextColumn =
    currentIndex < PIPELINE_STEPS.length - 1 ? PIPELINE_STEPS[currentIndex + 1] : null;

  return (
    <div className="flex items-center gap-3 px-4 pb-3">
      {/* Connected stepper */}
      <div className="flex items-center flex-1 min-w-0">
        {PIPELINE_STEPS.map((step, i) => {
          const isActive = step.id === normalizedCurrentColumn;
          const isPast = i < currentIndex;
          const isFuture = i > currentIndex;

          return (
            <React.Fragment key={step.id}>
              {/* Connector line before step (except first) */}
              {i > 0 && (
                <div
                  className={cn(
                    'h-px flex-1 min-w-3 max-w-8 transition-colors duration-300',
                    isPast || isActive ? 'bg-done' : 'bg-border'
                  )}
                />
              )}

              {/* Step */}
              <button
                type="button"
                onClick={() => onMove?.(taskId, step.id, 0)}
                disabled={!onMove}
                className={cn(
                  'group relative flex items-center gap-1.5 shrink-0 transition-all duration-200',
                  onMove && 'cursor-pointer'
                )}
                title={onMove ? `Move to ${step.label}` : step.label}
              >
                {/* Step indicator */}
                <div
                  className={cn(
                    'relative flex items-center justify-center rounded-full transition-all duration-200',
                    isPast && 'h-5 w-5 bg-done',
                    isActive &&
                      'h-5 w-5 border-2 border-accent bg-accent/15 shadow-[0_0_0_3px_var(--accent-subtle)]',
                    isFuture && 'h-4 w-4 border border-border bg-surface-subtle'
                  )}
                >
                  {isPast && <CheckCircle size={14} weight="fill" className="text-bg-canvas" />}
                  {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </div>

                {/* Label */}
                <span
                  className={cn(
                    'text-[11px] font-medium transition-colors duration-200',
                    isPast && 'text-done',
                    isActive && 'text-fg',
                    isFuture && 'text-fg-subtle group-hover:text-fg-muted'
                  )}
                >
                  {step.label}
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Quick advance button */}
      {nextColumn && onMove && (
        <button
          type="button"
          onClick={() => onMove(taskId, nextColumn.id, 0)}
          className="flex items-center gap-1 rounded-md border border-border bg-surface-subtle px-2.5 py-1 text-[11px] font-medium text-fg-muted transition-all duration-150 hover:bg-surface-emphasis hover:text-fg hover:border-fg-subtle"
          title={`Move to ${nextColumn.label}`}
        >
          <ArrowRight size={12} />
          {nextColumn.label}
        </button>
      )}

      {/* Run button for backlog tasks */}
      {currentColumn === 'backlog' && onMove && (
        <button
          type="button"
          onClick={() => onMove(taskId, 'in_progress', 0)}
          className="flex items-center gap-1 rounded-md bg-claude-subtle text-claude border border-claude/20 px-2.5 py-1 text-[11px] font-medium transition-all duration-150 hover:bg-claude-muted hover:shadow-[0_0_12px_rgba(217,119,87,0.25)]"
        >
          <Lightning size={12} weight="fill" />
          Run Now
        </button>
      )}
    </div>
  );
}
