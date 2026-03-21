import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/projects')({
  beforeLoad: () => {
    // Redirect to main codespaces page
    throw redirect({ to: '/codespaces' });
  },
});
