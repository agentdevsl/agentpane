import { DotsThree } from '@phosphor-icons/react';
import type { EventSource } from '@/lib/events/types';
import { EventSourceIcon } from './event-source-icon';
import { EventStatusBadge } from './event-status-badge';

interface EventSourceCardProps {
  source: EventSource;
  onEdit?: () => void;
}

export function EventSourceCard({ source, onEdit }: EventSourceCardProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-fg-subtle">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-subtle">
            <EventSourceIcon type={source.type} className="h-4 w-4 text-fg-muted" />
          </div>
          <div>
            <div className="text-sm font-medium text-fg">{source.name}</div>
            <div className="text-xs text-fg-muted">{source.type}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <EventStatusBadge status={source.status} />
          <button
            type="button"
            onClick={onEdit}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
          >
            <DotsThree className="h-4 w-4" weight="bold" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span>{source.eventCount} events</span>
        {source.lastEventAt && (
          <span>Last: {new Date(source.lastEventAt).toLocaleDateString()}</span>
        )}
      </div>

      <div className="rounded bg-surface-subtle px-2 py-1 font-mono text-xs text-fg-subtle">
        /hooks/events/{source.slug}
      </div>
    </div>
  );
}
