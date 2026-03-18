import {
  CheckCircle,
  Clock,
  Desktop,
  GearSix,
  Lightning,
  Stack,
  Stamp,
  Timer,
  Warning,
} from '@phosphor-icons/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { memo } from 'react';
import { Button } from '@/app/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils/format-time';

export type ProjectStatus = 'running' | 'idle' | 'needs-approval';

export type TaskCounts = {
  backlog: number;
  queued: number;
  inProgress: number;
  waitingApproval: number;
  verified: number;
  total: number;
};

export type ActiveAgent = {
  id: string;
  name: string;
  taskId: string;
  taskTitle: string;
  type: 'runner' | 'reviewer';
};

// Minimal project data needed for the card display
export type ProjectCardData = {
  id: string;
  name: string;
  path: string;
};

export interface ProjectCardProps {
  project: ProjectCardData;
  status: ProjectStatus;
  taskCounts: TaskCounts;
  activeAgents: ActiveAgent[];
  successRate?: number;
  lastRunAt?: Date | string | null;
}

const STATUS_CONFIG: Record<ProjectStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-success-muted text-success border-success/40',
  },
  idle: {
    label: 'Idle',
    className: 'bg-surface-muted text-fg-muted border-border',
  },
  'needs-approval': {
    label: 'Needs Approval',
    className: 'bg-attention-muted text-attention border-attention/40',
  },
};

const AVATAR_COLORS = [
  'bg-success-muted text-success',
  'bg-accent-muted text-accent',
  'bg-done-muted text-done',
  'bg-attention-muted text-attention',
] as const;

export function getAvatarColor(projectId: string): string {
  const hash = projectId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

interface MiniKanbanBarProps {
  icon: React.ReactNode;
  title: string;
  count: number;
  total: number;
  colorClass: string;
}

function MiniKanbanBar({
  icon,
  title,
  count,
  total,
  colorClass,
}: MiniKanbanBarProps): React.JSX.Element {
  const percentage = total > 0 ? (count / total) * 100 : 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex flex-col items-center gap-0.5 mb-1.5">
            <span className={colorClass}>{icon}</span>
            <span className={`font-semibold font-mono text-[10px] ${colorClass}`}>{count}</span>
          </div>
          <div className="h-1 bg-surface-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${colorClass.replace('text-', 'bg-')}`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function arePropsEqual(prev: ProjectCardProps, next: ProjectCardProps): boolean {
  if (prev.project.id !== next.project.id) return false;
  if (prev.status !== next.status) return false;

  const prevCounts = prev.taskCounts;
  const nextCounts = next.taskCounts;
  if (
    prevCounts.backlog !== nextCounts.backlog ||
    prevCounts.queued !== nextCounts.queued ||
    prevCounts.inProgress !== nextCounts.inProgress ||
    prevCounts.waitingApproval !== nextCounts.waitingApproval ||
    prevCounts.verified !== nextCounts.verified
  )
    return false;

  const prevAgents = prev.activeAgents;
  const nextAgents = next.activeAgents;
  if (prevAgents.length !== nextAgents.length) return false;
  for (let i = 0; i < prevAgents.length; i++) {
    const prevAgent = prevAgents[i];
    const nextAgent = nextAgents[i];
    if (!prevAgent || !nextAgent || prevAgent.id !== nextAgent.id) return false;
  }

  if (prev.lastRunAt?.toString() !== next.lastRunAt?.toString()) return false;

  return true;
}

export const ProjectCard = memo(function ProjectCard({
  project,
  status,
  taskCounts,
  activeAgents,
  successRate,
  lastRunAt,
}: ProjectCardProps): React.JSX.Element {
  const navigate = useNavigate();
  const statusConfig = STATUS_CONFIG[status];
  const avatarColor = getAvatarColor(project.id);
  const initials = getInitials(project.name);

  const isNeedsApproval = status === 'needs-approval';

  const handleDoubleClick = () => {
    navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: Card needs div styling, not button semantics
    <div
      className="rounded-lg border border-border bg-surface overflow-hidden transition-all hover:border-fg-subtle hover:shadow-md cursor-pointer"
      data-testid="project-card"
      role="button"
      tabIndex={0}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleDoubleClick();
      }}
    >
      {/* Header */}
      <div className="p-4 flex items-start gap-3 border-b border-border-muted">
        <div
          className={`w-12 h-12 rounded-md flex items-center justify-center text-lg font-bold shrink-0 ${avatarColor}`}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-fg truncate">{project.name}</h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-full border ${statusConfig.className}`}
              data-testid="project-status"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              {statusConfig.label}
            </span>
          </div>
          <p className="text-xs text-fg-subtle font-mono truncate mt-1">{project.path}</p>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        {/* Mini Kanban */}
        <div className="flex gap-1 mb-4">
          <MiniKanbanBar
            icon={<Stack size={14} />}
            title="Backlog"
            count={taskCounts.backlog}
            total={taskCounts.total}
            colorClass="text-fg-muted"
          />
          <MiniKanbanBar
            icon={<Timer size={14} />}
            title="Queued"
            count={taskCounts.queued}
            total={taskCounts.total}
            colorClass="text-[var(--secondary-fg)]"
          />
          <MiniKanbanBar
            icon={<Lightning size={14} />}
            title="In Progress"
            count={taskCounts.inProgress}
            total={taskCounts.total}
            colorClass="text-attention"
          />
          <MiniKanbanBar
            icon={<Stamp size={14} />}
            title="Waiting Approval"
            count={taskCounts.waitingApproval}
            total={taskCounts.total}
            colorClass="text-accent"
          />
          <MiniKanbanBar
            icon={<CheckCircle size={14} />}
            title="Done"
            count={taskCounts.verified}
            total={taskCounts.total}
            colorClass="text-success"
          />
        </div>

        {/* Agent Activity */}
        <div
          className={`rounded-md p-3 ${isNeedsApproval ? 'bg-attention-muted border border-attention/30' : 'bg-canvas'}`}
        >
          <div className="flex items-center justify-between mb-2 text-xs">
            <span
              className={`flex items-center gap-1.5 ${isNeedsApproval ? 'text-attention' : 'text-fg-muted'}`}
            >
              {isNeedsApproval ? (
                <>
                  <Warning className="h-3.5 w-3.5" />
                  Pending Review
                </>
              ) : (
                <>
                  <Desktop className="h-3.5 w-3.5" />
                  Active Agents
                </>
              )}
            </span>
            {!isNeedsApproval && activeAgents.length > 0 && (
              <span className="text-success font-medium">{activeAgents.length} running</span>
            )}
            {!isNeedsApproval && activeAgents.length === 0 && (
              <span className="text-fg-muted">None</span>
            )}
          </div>
          <div className="space-y-2">
            {isNeedsApproval && taskCounts.waitingApproval > 0 && (
              <div className="text-xs text-fg">
                <strong>#{taskCounts.waitingApproval}</strong> task
                {taskCounts.waitingApproval > 1 ? 's' : ''} awaiting approval
              </div>
            )}
            {!isNeedsApproval && activeAgents.length === 0 && (
              <div className="text-xs text-fg-subtle">No agents currently running</div>
            )}
            {!isNeedsApproval &&
              activeAgents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 text-xs">
                  <div
                    className={`w-5 h-5 rounded-full border border-border ${
                      agent.type === 'runner'
                        ? 'bg-gradient-to-br from-success to-accent'
                        : 'bg-gradient-to-br from-done to-danger'
                    }`}
                  />
                  <span className="text-fg font-medium flex-1 truncate">{agent.name}</span>
                  <span className="text-fg-subtle font-mono">#{agent.taskId.slice(-6)}</span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-surface-subtle border-t border-border-muted flex items-center justify-between">
        <div className="flex gap-4">
          {successRate !== undefined && (
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              <CheckCircle className="h-3.5 w-3.5" />
              <span>{successRate.toFixed(1)}% success</span>
            </div>
          )}
          {lastRunAt && (
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Clock className="h-3.5 w-3.5" />
              <span>Last run {formatRelativeTime(lastRunAt)}</span>
            </div>
          )}
          {!successRate && !lastRunAt && activeAgents.length === 0 && (
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Clock className="h-3.5 w-3.5" />
              <span>No recent activity</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/projects/$projectId/settings"
            params={{ projectId: project.id }}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
            data-testid="project-card-settings"
          >
            <GearSix className="h-4 w-4" />
            <span className="sr-only">Project settings</span>
          </Link>
          <Button variant="outline" size="sm" asChild>
            <Link to="/projects/$projectId" params={{ projectId: project.id }}>
              {isNeedsApproval ? 'Review' : 'Open'}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}, arePropsEqual);

// Re-export for backward compatibility (tests and other consumers)
export { formatRelativeTime } from '@/lib/utils/format-time';

interface AddProjectCardProps {
  onClick: () => void;
}

export function AddProjectCard({ onClick }: AddProjectCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-dashed border-border bg-transparent min-h-[280px] flex items-center justify-center cursor-pointer transition-all hover:border-accent hover:bg-accent-muted"
    >
      <div className="text-center text-fg-muted">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-surface-muted flex items-center justify-center">
          <svg
            className="w-6 h-6 text-fg-subtle"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            role="img"
            aria-labelledby="add-project-icon-title"
          >
            <title id="add-project-icon-title">Add new project</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </div>
        <div className="font-medium text-fg mb-1">Add New Project</div>
        <div className="text-sm">Import or create a project</div>
      </div>
    </button>
  );
}
