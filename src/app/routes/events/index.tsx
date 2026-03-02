import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/events/')({
  component: EventsIndex,
});

function EventsIndex(): React.JSX.Element {
  return <Navigate to="/events/sources" />;
}
