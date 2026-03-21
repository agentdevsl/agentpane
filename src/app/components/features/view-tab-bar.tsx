import { Gear, GridFour, Kanban, Monitor } from '@phosphor-icons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useCodespaceData } from '@/app/providers/codespace-context';
import { cn } from '@/lib/utils/cn';

// =============================================================================
// ViewTabBar Component
// =============================================================================

interface ViewTab {
  readonly label: string;
  readonly to: string;
  readonly icon: typeof GridFour;
  readonly matchPrefix: string;
  readonly requiresCodespace?: boolean;
}

const viewTabs: readonly ViewTab[] = [
  { label: 'Codespaces', to: '/codespaces', icon: GridFour, matchPrefix: '/codespaces' },
  {
    label: 'Kanban Board',
    to: '/codespaces/$codespaceId',
    icon: Kanban,
    matchPrefix: '/codespaces/',
    requiresCodespace: true,
  },
  { label: 'Sessions', to: '/sessions', icon: Monitor, matchPrefix: '/sessions' },
  { label: 'Settings', to: '/settings', icon: Gear, matchPrefix: '/settings' },
] as const;

export function ViewTabBar(): React.JSX.Element {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const { currentCodespaceId } = useCodespaceData();

  return (
    <div
      className="flex items-center gap-1 border-b border-border bg-surface px-4 py-1.5"
      data-testid="view-tab-bar"
    >
      <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
        View
      </span>
      {viewTabs.map((tab) => {
        if (tab.requiresCodespace && !currentCodespaceId) return null;

        const Icon = tab.icon;
        const params =
          tab.requiresCodespace && currentCodespaceId ? { codespaceId: currentCodespaceId } : {};

        // Kanban is active only on exact codespace pages (not /codespaces list)
        const isActive = tab.requiresCodespace
          ? currentPath.startsWith(`/codespaces/${currentCodespaceId}`)
          : tab.matchPrefix === '/codespaces'
            ? currentPath === '/codespaces' || currentPath === '/codespaces/'
            : currentPath.startsWith(tab.matchPrefix);

        return (
          <Link
            key={tab.label}
            to={tab.to}
            params={params}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
              isActive
                ? 'bg-accent text-white shadow-sm'
                : 'text-fg-muted hover:bg-surface-subtle hover:text-fg'
            )}
            data-testid={`view-tab-${tab.label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <Icon size={14} weight={isActive ? 'fill' : 'regular'} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
