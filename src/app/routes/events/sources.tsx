import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/events/sources')({
  component: EventSourcesPage,
});

function EventSourcesPage(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Event Sources</h2>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
        >
          + Add Source
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-fg-muted">No event sources configured</p>
          <p className="text-xs text-fg-subtle">
            Connect GitHub, Linear, or other sources to start receiving events
          </p>
        </div>
      </div>
    </div>
  );
}
