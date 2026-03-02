import type { EventLogEntry } from '@/lib/events/types';
import { cn } from '@/lib/utils/cn';
import { EventStatusBadge } from './event-status-badge';

interface EventLogTimelineProps {
  events: EventLogEntry[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function EventLogTimeline({
  events,
  selectedId,
  onSelect,
}: EventLogTimelineProps): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-fg-muted">
        No events received yet
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border overflow-y-auto">
      {events.map((event) => (
        <button
          key={event.id}
          type="button"
          onClick={() => onSelect(event.id)}
          className={cn(
            'flex flex-col gap-1 p-3 text-left transition-colors hover:bg-surface-subtle',
            selectedId === event.id && 'bg-accent-muted'
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-fg">
              {event.eventType}
              {event.action ? `.${event.action}` : ''}
            </span>
            <EventStatusBadge status={event.status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span>{new Date(event.receivedAt).toLocaleTimeString()}</span>
            {event.matchedSubscriptions.length > 0 && (
              <span>{event.matchedSubscriptions.length} matched</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
