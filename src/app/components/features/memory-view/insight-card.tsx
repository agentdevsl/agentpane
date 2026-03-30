import { ArrowsClockwise, CaretRight, Check, Clock, Tag, Trash, X } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { formatRelativeDate } from './formatters';
import { InsightSourceBadge } from './insight-source-badge';
import type { InsightInjection } from './types';

// =============================================================================
// Constants
// =============================================================================

const INSIGHT_TAG_COLORS = [
  { bg: 'bg-accent-muted', text: 'text-accent' },
  { bg: 'bg-success-muted', text: 'text-success' },
  { bg: 'bg-done-muted', text: 'text-done' },
  { bg: 'bg-attention-muted', text: 'text-attention' },
  { bg: 'bg-secondary-muted', text: 'text-secondary' },
  { bg: 'bg-danger-muted', text: 'text-danger' },
] as const;

function getInsightTagColor(tag: string): { bg: string; text: string } {
  const hash = tag.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return INSIGHT_TAG_COLORS[hash % INSIGHT_TAG_COLORS.length] ?? INSIGHT_TAG_COLORS[0];
}

const CATEGORY_STYLES: Record<string, string> = {
  pattern: 'bg-accent-subtle text-accent',
  anti_pattern: 'bg-danger-subtle text-danger',
  decision: 'bg-done-subtle text-done',
  architecture: 'bg-success-subtle text-success',
  error_lesson: 'bg-attention-subtle text-attention',
};

const CATEGORY_LABELS: Record<string, string> = {
  pattern: 'Pattern',
  anti_pattern: 'Anti-Pattern',
  decision: 'Decision',
  architecture: 'Architecture',
  error_lesson: 'Error Lesson',
};

// =============================================================================
// Sub-components
// =============================================================================

interface InsightCardProps {
  insight: {
    id: string;
    content: string;
    source: string;
    tags: string[];
    createdAt: string;
    skillId: string | null;
    status?: 'active' | 'pending_review' | 'rejected';
    category?: string | null;
    updatedAt?: string | null;
  };
  injections: Array<InsightInjection> | undefined;
  onDelete: (id: string) => undefined | Promise<boolean>;
  onExpand: (insightId: string) => void;
  onApprove?: (id: string) => void | Promise<unknown>;
  onReject?: (id: string) => void | Promise<unknown>;
}

function InjectionBadge({ count }: { count: number | undefined }): React.JSX.Element | null {
  if (count === undefined || count === 0) return null;

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent">
      <ArrowsClockwise className="h-3 w-3" />
      {count}x used
    </span>
  );
}

function InjectionHistory({
  injections,
}: {
  injections: Array<InsightInjection>;
}): React.JSX.Element {
  if (injections.length === 0) {
    return (
      <p className="text-xs text-fg-subtle">
        This insight has not been injected into any agent sessions yet.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
        Injection history
      </p>
      <div className="max-h-40 overflow-y-auto">
        {injections.map((inj) => (
          <div
            key={`${inj.sessionId}-${inj.timestamp}`}
            className="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-surface-muted"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {inj.codespaceName && (
                <span className="text-[11px] font-medium text-fg-muted">{inj.codespaceName}</span>
              )}
              <span className="truncate text-fg">
                {inj.taskTitle ? (
                  inj.taskTitle
                ) : inj.taskId ? (
                  <span className="font-mono text-fg-muted">{inj.taskId.slice(0, 8)}</span>
                ) : (
                  'Unknown task'
                )}
              </span>
            </div>
            <span className="ml-3 flex shrink-0 items-center gap-1 text-[11px] text-fg-subtle">
              <Clock size={10} />
              {formatRelativeDate(new Date(inj.timestamp).toISOString())}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Main card
// =============================================================================

export function InsightCard({
  insight,
  injections,
  onDelete,
  onExpand,
  onApprove,
  onReject,
}: InsightCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  // Load injections on first expand
  useWatchEffect(() => {
    if (expanded) {
      onExpand(insight.id);
    }
  }, [expanded, insight.id, onExpand]);

  const injectionCount = injections?.length;

  return (
    <div
      className={cn(
        'group/card rounded-lg border border-border bg-surface transition-all duration-200',
        expanded ? 'shadow-sm' : 'hover:border-fg-subtle hover:shadow-md'
      )}
      style={
        expanded
          ? { background: 'linear-gradient(135deg, rgba(88,166,255,0.04) 0%, transparent 60%)' }
          : undefined
      }
    >
      {/* Content first — the insight text is the hero */}
      <button
        type="button"
        className="w-full cursor-pointer px-4 pt-4 pb-2 text-left"
        onClick={() => setExpanded((prev: boolean) => !prev)}
        aria-expanded={expanded}
      >
        <span className={cn('block text-[13px] text-fg', !expanded && 'line-clamp-2')}>
          {insight.content}
        </span>
      </button>

      {/* Tags */}
      {insight.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          {insight.tags.map((tag) => {
            const colors = getInsightTagColor(tag);
            return (
              <span
                key={tag}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  colors.bg,
                  colors.text
                )}
              >
                <Tag size={9} weight="bold" />
                {tag}
              </span>
            );
          })}
        </div>
      )}

      {/* Footer — metadata + actions */}
      <div className="flex items-center justify-between px-4 pb-3 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <InsightSourceBadge source={insight.source} />
          {insight.category && CATEGORY_LABELS[insight.category] && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                CATEGORY_STYLES[insight.category] ?? 'bg-surface-muted text-fg-muted'
              )}
            >
              {CATEGORY_LABELS[insight.category]}
            </span>
          )}
          {insight.status === 'pending_review' && (
            <span className="inline-flex items-center rounded-full bg-attention-subtle px-2 py-0.5 text-[10px] font-medium text-attention">
              Pending Review
            </span>
          )}
          {insight.status === 'rejected' && (
            <span className="inline-flex items-center rounded-full bg-danger-subtle px-2 py-0.5 text-[10px] font-medium text-danger-muted">
              Rejected
            </span>
          )}
          <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
            <Clock size={10} />
            {insight.updatedAt && insight.updatedAt !== insight.createdAt
              ? `Updated ${formatRelativeDate(insight.updatedAt)}`
              : formatRelativeDate(insight.createdAt)}
          </span>
          <InjectionBadge count={injectionCount} />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-fg-subtle opacity-0 transition-opacity group-hover/card:opacity-100 hover:text-danger"
            disabled={deleting}
            aria-label="Delete insight"
            onClick={async () => {
              setDeleting(true);
              try {
                await onDelete(insight.id);
              } finally {
                setDeleting(false);
              }
            }}
          >
            <Trash size={12} />
          </Button>
          <button
            type="button"
            className="flex items-center gap-0.5 text-[11px] text-fg-muted hover:text-fg"
            onClick={() => setExpanded((prev: boolean) => !prev)}
          >
            <CaretRight
              size={11}
              className={cn('transition-transform duration-200 ease-out', expanded && 'rotate-90')}
            />
            {expanded ? 'Less' : 'More'}
          </button>
        </div>
      </div>

      {/* Approve / Reject actions for pending insights */}
      {insight.status === 'pending_review' && onApprove && onReject && (
        <div className="flex items-center gap-2 border-t border-border-muted/50 px-4 pb-3 pt-2">
          <Button
            variant="default"
            size="sm"
            className="gap-1 bg-success hover:bg-success-hover"
            disabled={actionPending}
            onClick={async () => {
              setActionPending(true);
              try {
                await onApprove(insight.id);
              } finally {
                setActionPending(false);
              }
            }}
          >
            <Check size={14} weight="bold" />
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-danger hover:border-danger hover:text-danger"
            disabled={actionPending}
            onClick={async () => {
              setActionPending(true);
              try {
                await onReject(insight.id);
              } finally {
                setActionPending(false);
              }
            }}
          >
            <X size={14} weight="bold" />
            Reject
          </Button>
        </div>
      )}

      {/* Expanded injection history */}
      <div
        className={cn(
          'grid transition-all duration-200 ease-out',
          expanded && injections !== undefined
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border px-4 py-3">
            {injections !== undefined && <InjectionHistory injections={injections} />}
          </div>
        </div>
      </div>
    </div>
  );
}
