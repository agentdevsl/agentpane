import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/events/log')({
  component: EventLogPage,
});

function EventLogPage(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Event Log</h2>
      </div>
      <div className="flex flex-1 gap-4">
        {/* Timeline (left panel) */}
        <div className="flex flex-1 flex-col rounded-lg border border-border">
          <div className="flex items-center justify-center p-8 text-sm text-fg-muted">
            No events received yet. Events will appear here as webhooks arrive.
          </div>
        </div>
      </div>
    </div>
  );
}
