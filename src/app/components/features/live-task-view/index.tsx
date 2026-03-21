import {
  ArrowRight,
  Broadcast,
  CaretRight,
  CheckCircle,
  GitBranch,
  Lightning,
} from '@phosphor-icons/react';
import React, { Suspense, useMemo, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import type { TopologyGraph, TopologyNode } from '@/lib/topology/types';
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

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  // Fetch session events to build initial topology data when a task is selected
  useWatchEffect(() => {
    const sessionId = selectedTask?.sessionId;
    if (!sessionId) {
      setTopologyData(undefined);
      return;
    }

    const fetchTopologyFromEvents = async () => {
      try {
        const result = await apiClient.sessions.getEvents(sessionId, { limit: 500 });
        if (!result.ok) return;

        // Handle both response shapes: {data: [...], pagination} or flat [...]
        const rawData = result.data as
          | { data: Array<{ id: string; type: string; timestamp: number; data: unknown }> }
          | Array<{ id: string; type: string; timestamp: number; data: unknown }>;
        const events = Array.isArray(rawData) ? rawData : rawData.data;
        const nodes = new Map<string, TopologyNode>();
        const edges: Array<{ id: string; sourceId: string; targetId: string }> = [];

        for (const event of events) {
          if (event.type === 'topology:agent_spawned') {
            const d = event.data as {
              agentId: string;
              name: string;
              role?: string;
              parentId?: string;
              timestamp?: number;
            };
            const node: TopologyNode = {
              id: d.agentId,
              name: d.name,
              role: ([
                'orchestrator',
                'planner',
                'coder',
                'reviewer',
                'tester',
                'scanner',
                'deployer',
              ].includes(d.role ?? '')
                ? d.role
                : 'coder') as TopologyNode['role'],
              status: 'running',
              parentId: d.parentId ?? null,
              childIds: [],
              progress: 0,
              tokens: 0,
              cost: 0,
              turns: 0,
              messages: 0,
              startedAt: d.timestamp ?? event.timestamp,
              completedAt: null,
              verified: false,
              verificationScore: 0,
              decisions: [],
            };
            nodes.set(d.agentId, node);
            if (d.parentId) {
              edges.push({
                id: `${d.parentId}->${d.agentId}`,
                sourceId: d.parentId,
                targetId: d.agentId,
              });
              const parent = nodes.get(d.parentId);
              if (parent) parent.childIds.push(d.agentId);
            }
          } else if (event.type === 'container-agent:started' && nodes.size === 0) {
            // Container-agent session: create root node from started event
            const d = event.data as { taskId?: string; model?: string };
            const agentId = selectedTask?.agentId ?? `agent-${d.taskId ?? selectedTask?.id}`;
            nodes.set(agentId, {
              id: agentId,
              name: d.model ?? selectedTask?.title ?? 'Agent',
              role: 'coder',
              status: 'running',
              parentId: null,
              childIds: [],
              progress: 0,
              tokens: 0,
              cost: 0,
              turns: 0,
              messages: 0,
              startedAt: event.timestamp,
              completedAt: null,
              verified: false,
              verificationScore: 0,
              decisions: [],
            });
          } else if (event.type === 'topology:agent_progress') {
            const d = event.data as { agentId: string; tokens?: number; toolUses?: number };
            const node = nodes.get(d.agentId);
            if (node && d.tokens) {
              node.tokens = d.tokens;
              node.cost = Number.parseFloat((d.tokens * 0.000009).toFixed(4));
              node.progress = Math.min(95, Math.floor(d.tokens / 500));
              node.turns = d.toolUses ?? node.turns;
            }
          } else if (event.type === 'topology:agent_completed') {
            const d = event.data as {
              agentId: string;
              status?: string;
              tokens?: number;
              timestamp?: number;
            };
            const node = nodes.get(d.agentId);
            if (node) {
              node.status =
                d.status === 'completed'
                  ? 'completed'
                  : d.status === 'stopped'
                    ? 'stopped'
                    : 'failed';
              node.completedAt = d.timestamp ?? event.timestamp;
              if (d.tokens) {
                node.tokens = d.tokens;
                node.cost = Number.parseFloat((d.tokens * 0.000009).toFixed(4));
              }
              if (node.status === 'completed') node.progress = 100;
            }
          } else if (event.type === 'container-agent:tool:start') {
            // Update root node tool count for container-agent sessions
            const firstNode = nodes.values().next().value;
            if (firstNode) {
              firstNode.turns += 1;
              firstNode.tokens += 500;
              firstNode.cost = Number.parseFloat((firstNode.tokens * 0.000009).toFixed(4));
              firstNode.progress = Math.min(95, firstNode.turns * 10);
            }
          } else if (event.type === 'container-agent:message') {
            const firstNode = nodes.values().next().value;
            if (firstNode) firstNode.messages += 1;
          } else if (event.type === 'container-agent:plan_ready') {
            const firstNode = nodes.values().next().value;
            if (firstNode) {
              firstNode.status = 'verifying';
              firstNode.progress = 80;
            }
          }
        }

        // If still no nodes, create a root from task metadata
        if (nodes.size === 0) {
          // Build root node from container-agent events or task metadata
          const agentId = selectedTask?.agentId ?? `agent-${selectedTask?.id}`;
          const isCompleted =
            selectedTask?.column === 'verified' || selectedTask?.column === 'done';
          const isRunning = selectedTask?.column === 'in_progress';
          const isPlanReady = selectedTask?.lastAgentStatus === 'planning';

          // Estimate tokens from tool events
          let toolCount = 0;
          for (const event of events) {
            if (event.type.includes('tool:start')) toolCount++;
          }

          const rootNode: TopologyNode = {
            id: agentId,
            name: selectedTask?.title ?? 'Agent',
            role: 'coder',
            status: isCompleted
              ? 'completed'
              : isPlanReady
                ? 'verifying'
                : isRunning
                  ? 'running'
                  : 'queued',
            parentId: null,
            childIds: [],
            progress: isCompleted ? 100 : isPlanReady ? 80 : Math.min(90, toolCount * 10),
            tokens: toolCount * 500,
            cost: Number.parseFloat((toolCount * 500 * 0.000009).toFixed(4)),
            turns: toolCount,
            messages: events.filter((e) => e.type.includes('message')).length,
            startedAt: events[0]?.timestamp ?? Date.now(),
            completedAt: isCompleted ? (events[events.length - 1]?.timestamp ?? null) : null,
            verified: isCompleted,
            verificationScore: isCompleted ? 1 : 0,
            decisions: [],
          };
          nodes.set(agentId, rootNode);
        }

        setTopologyData({
          nodes: Array.from(nodes.values()),
          edges,
          taskId: selectedTask?.id ?? '',
          taskName: selectedTask?.title ?? '',
          taskPriority: selectedTask?.priority ?? '',
        });
      } catch {
        // Non-critical — topology will still try live streaming
      }
    };

    void fetchTopologyFromEvents();
  }, [selectedTask?.sessionId, selectedTask?.id, selectedTask?.title, selectedTask?.priority]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="live-task-view">
      {/* Left: Task List Sidebar */}
      <TaskListSidebar
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        onTaskSelect={setSelectedTaskId}
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
// TaskStatusPipeline — visual kanban column indicator with progression
// =============================================================================

const PIPELINE_COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: 'bg-fg-subtle' },
  { id: 'queued', label: 'Queued', color: 'bg-accent' },
  { id: 'in_progress', label: 'In Progress', color: 'bg-success' },
  { id: 'waiting_approval', label: 'Review', color: 'bg-warning' },
  { id: 'verified', label: 'Done', color: 'bg-done' },
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
  const currentIndex = PIPELINE_COLUMNS.findIndex((c) => c.id === currentColumn);
  const nextColumn =
    currentIndex < PIPELINE_COLUMNS.length - 1 ? PIPELINE_COLUMNS[currentIndex + 1] : null;

  return (
    <div className="flex items-center gap-1 px-4 pb-2.5">
      {/* Pipeline steps */}
      <div className="flex items-center gap-0.5 flex-1">
        {PIPELINE_COLUMNS.map((col, i) => {
          const isActive = col.id === currentColumn;
          const isPast = i < currentIndex;
          return (
            <React.Fragment key={col.id}>
              {i > 0 && (
                <CaretRight
                  size={10}
                  className={cn(
                    'shrink-0',
                    isPast ? 'text-done' : i <= currentIndex ? 'text-fg-muted' : 'text-fg-subtle/30'
                  )}
                />
              )}
              <button
                type="button"
                onClick={() => onMove?.(taskId, col.id, 0)}
                disabled={!onMove}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150',
                  isActive
                    ? `${col.color}/15 text-fg border border-current/20 shadow-sm`
                    : isPast
                      ? 'text-done/70 hover:bg-done/10'
                      : 'text-fg-subtle hover:bg-surface-subtle',
                  onMove && 'cursor-pointer'
                )}
                title={onMove ? `Move to ${col.label}` : col.label}
              >
                {isPast && <CheckCircle size={12} weight="fill" className="text-done" />}
                {isActive && <div className={cn('h-[6px] w-[6px] rounded-full', col.color)} />}
                <span>{col.label}</span>
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
