import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import type { EventLogEntry } from '@/lib/events/types';
import { EventStatusBadge } from './event-status-badge';

interface EventLogDetailProps {
  event: EventLogEntry;
  sourceName?: string;
}

export function EventLogDetail({ event, sourceName }: EventLogDetailProps): React.JSX.Element {
  const [showPayload, setShowPayload] = useState(false);

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-fg">
            {event.eventType}
            {event.action ? <span className="text-fg-muted">.{event.action}</span> : null}
          </h3>
          {sourceName && <p className="text-xs text-fg-muted">{sourceName}</p>}
        </div>
        <EventStatusBadge status={event.status} />
      </div>

      {/* Error banner */}
      {event.error && (
        <div className="rounded-md bg-danger-muted px-3 py-2 text-xs text-danger">
          {event.error}
        </div>
      )}

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-fg-subtle">Received</span>
          <p className="text-fg">{new Date(event.receivedAt).toLocaleString()}</p>
        </div>
        {event.processedAt && (
          <div>
            <span className="text-fg-subtle">Processed</span>
            <p className="text-fg">{new Date(event.processedAt).toLocaleString()}</p>
          </div>
        )}
        <div>
          <span className="text-fg-subtle">Delivery ID</span>
          <p className="truncate font-mono text-fg">{event.deliveryId}</p>
        </div>
        <div>
          <span className="text-fg-subtle">Matched Subscriptions</span>
          <p className="text-fg">{event.matchedSubscriptions?.length ?? 0}</p>
        </div>
      </div>

      {/* Matched subscription details */}
      {(event.matchedSubscriptions?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-fg-muted">Matched Subscriptions</span>
          {event.matchedSubscriptions.map((ms) => (
            <div
              key={ms.subscriptionId}
              className="flex items-center gap-2 rounded bg-surface-subtle px-2 py-1 text-xs"
            >
              <span className="font-mono text-fg-subtle">{ms.subscriptionId}</span>
              {ms.taskId && (
                <span className="text-success">&rarr; Task {ms.taskId.slice(0, 8)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Collapsible payload */}
      <div>
        <button
          type="button"
          aria-expanded={showPayload}
          onClick={() => setShowPayload(!showPayload)}
          className="flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
        >
          {showPayload ? <CaretDown className="h-3 w-3" /> : <CaretRight className="h-3 w-3" />}
          Raw Payload
        </button>
        {showPayload && (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-subtle p-3 text-xs text-fg-muted">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
