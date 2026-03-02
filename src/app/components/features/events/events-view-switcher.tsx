import { Lightning, ListBullets, Plugs } from '@phosphor-icons/react';
import { Link, useMatches } from '@tanstack/react-router';
import { cn } from '@/lib/utils/cn';

export function EventsViewSwitcher(): React.JSX.Element {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.fullPath ?? '';

  const tabs = [
    { label: 'Sources', to: '/events/sources', icon: Plugs },
    { label: 'Subscriptions', to: '/events/subscriptions', icon: Lightning },
    { label: 'Event Log', to: '/events/log', icon: ListBullets },
  ] as const;

  return (
    <div className="flex items-center gap-1 rounded-lg bg-surface-subtle p-1">
      {tabs.map((tab) => {
        const isActive = currentPath === tab.to || currentPath.startsWith(`${tab.to}/`);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
              isActive
                ? 'bg-surface text-fg shadow-sm'
                : 'text-fg-muted hover:text-fg hover:bg-surface/50'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
