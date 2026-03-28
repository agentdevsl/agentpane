import { Syringe, Trash } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { formatRelativeDate } from './formatters';
import { InsightSourceBadge } from './insight-source-badge';
import type { InsightInjection } from './types';

interface InsightCardProps {
  insight: {
    id: string;
    content: string;
    source: string;
    tags: string[];
    createdAt: string;
    skillId: string | null;
  };
  injections: Array<InsightInjection> | undefined;
  onDelete: (id: string) => undefined | Promise<boolean>;
  onExpand: (insightId: string) => void;
}

function InjectionBadge({ count }: { count: number | undefined }): React.JSX.Element {
  if (count === undefined) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-subtle">
        <Syringe className="h-3 w-3" />
        ...
      </span>
    );
  }

  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-subtle">
        <Syringe className="h-3 w-3" />
        Not yet used
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-accent">
      <Syringe className="h-3 w-3" />
      {count} {count === 1 ? 'injection' : 'injections'}
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
      <p className="text-xs text-fg-subtle italic">
        This insight has not been injected into any agent sessions yet.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-fg-muted">Injection history</p>
      <div className="max-h-40 overflow-y-auto">
        {injections.map((inj) => (
          <div
            key={`${inj.sessionId}-${inj.timestamp}`}
            className="flex items-center justify-between rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-muted"
          >
            <span className="truncate font-mono text-fg-subtle" title={inj.sessionId}>
              Session {inj.sessionId.slice(0, 8)}
            </span>
            <span className="ml-2 shrink-0 text-fg-subtle">
              {formatRelativeDate(new Date(inj.timestamp).toISOString())}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InsightCard({
  insight,
  injections,
  onDelete,
  onExpand,
}: InsightCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load injections on first expand
  useWatchEffect(() => {
    if (expanded) {
      onExpand(insight.id);
    }
  }, [expanded, insight.id, onExpand]);

  const injectionCount = injections?.length;

  return (
    <div className="relative rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <InsightSourceBadge source={insight.source} />
          <span className="text-xs text-fg-muted">{formatRelativeDate(insight.createdAt)}</span>
          <InjectionBadge count={injectionCount} />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-fg-muted hover:border-danger hover:text-danger"
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
          <Trash size={14} />
          Delete
        </Button>
      </div>

      <button
        type="button"
        className={cn(
          'mt-2 w-full cursor-pointer text-left text-sm text-fg',
          !expanded && 'line-clamp-4'
        )}
        onClick={() => setExpanded((prev: boolean) => !prev)}
        aria-expanded={expanded}
      >
        {insight.content}
      </button>

      {insight.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {insight.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {expanded && injections !== undefined && (
        <div className="mt-3 border-t border-border pt-3">
          <InjectionHistory injections={injections} />
        </div>
      )}
    </div>
  );
}
