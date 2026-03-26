import { createFileRoute, Outlet, useMatches } from '@tanstack/react-router';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { EventsViewSwitcher } from '@/app/components/features/events/events-view-switcher';

export const Route = createFileRoute('/events')({
  component: EventsLayout,
});

function EventsLayout(): React.JSX.Element {
  const matches = useMatches();
  const isLogView = matches.some((m) => m.fullPath === '/events/log');
  const isSubscriptionsView = matches.some((m) => m.fullPath === '/events/subscriptions');

  return (
    <LayoutShell
      breadcrumbs={[
        { label: 'Events', to: '/events' },
        ...(isLogView ? [{ label: 'Event Log' }] : []),
        ...(isSubscriptionsView ? [{ label: 'Subscriptions' }] : []),
      ]}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-6 pt-4">
          <EventsViewSwitcher />
        </div>
        <Outlet />
      </div>
    </LayoutShell>
  );
}
