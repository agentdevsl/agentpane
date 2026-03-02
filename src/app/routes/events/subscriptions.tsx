import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/events/subscriptions')({
  component: SubscriptionsPage,
});

function SubscriptionsPage(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Subscriptions</h2>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
        >
          + Add Subscription
        </button>
      </div>
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-center p-8 text-sm text-fg-muted">
          No subscriptions configured. Create a subscription to automatically create tasks from
          events.
        </div>
      </div>
    </div>
  );
}
