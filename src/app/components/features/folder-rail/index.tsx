import {
  BookOpen,
  Cube,
  Gear,
  Monitor,
  PuzzlePiece,
  Robot,
  TreeStructure,
} from '@phosphor-icons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useFolderData } from '@/app/providers/folder-context';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

// =============================================================================
// Quick-access nav icons for the rail
// =============================================================================

interface RailNavItem {
  readonly label: string;
  readonly to: string;
  readonly icon: typeof Monitor;
  readonly matchPrefix: string;
}

const railNavItems: readonly RailNavItem[] = [
  { label: 'Sessions', to: '/sessions', icon: Monitor, matchPrefix: '/sessions' },
  { label: 'Agents', to: '/agents', icon: Robot, matchPrefix: '/agents' },
  { label: 'Designer', to: '/designer', icon: TreeStructure, matchPrefix: '/designer' },
  { label: 'Terraform', to: '/terraform', icon: Cube, matchPrefix: '/terraform' },
  { label: 'Marketplace', to: '/marketplace', icon: PuzzlePiece, matchPrefix: '/marketplace' },
  { label: 'Catalog', to: '/catalog', icon: BookOpen, matchPrefix: '/catalog' },
] as const;

// =============================================================================
// OrgRail Component
// =============================================================================

/**
 * OrgRail -- 52px-wide vertical icon rail on the far left (Tier 1).
 * Shows AgentPane logo, quick-access nav icons, settings, and user avatar.
 */
export function FolderRail(): React.JSX.Element {
  const { isFolderPanelOpen, toggleFolderPanel } = useFolderData();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [isHealthy, setIsHealthy] = useState(true);

  useMountEffect(() => {
    const checkHealth = async () => {
      const result = await apiClient.system.health();
      const nextHealthy = result.ok && result.data.status === 'healthy';
      setIsHealthy((prev) => (prev === nextHealthy ? prev : nextHealthy));
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  });

  return (
    <nav
      className="flex h-full w-[52px] min-w-[52px] shrink-0 flex-col items-center border-r border-border-subtle bg-surface z-30 relative"
      data-testid="org-rail"
    >
      {/* Top section: AgentPane logo */}
      <div className="flex flex-col items-center gap-1 pt-3 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleFolderPanel}
              className={cn(
                'relative flex h-[38px] w-[38px] items-center justify-center rounded-lg overflow-hidden transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] cursor-pointer border-2',
                'bg-surface-subtle shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_0_0_1px_rgba(255,255,255,0.06)]',
                isFolderPanelOpen
                  ? 'border-accent shadow-[0_0_12px_rgba(34,211,238,0.19)]'
                  : 'border-transparent hover:scale-105'
              )}
              data-testid="org-avatar"
            >
              <svg
                className="h-6 w-6 drop-shadow-[0_0_4px_rgba(163,113,247,0.3)]"
                viewBox="0 0 32 32"
                fill="none"
                aria-hidden="true"
              >
                <defs>
                  <radialGradient id="railCoreGrad" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fff" />
                    <stop offset="50%" stopColor="#3fb950" />
                    <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <line
                  x1="14"
                  y1="14"
                  x2="6"
                  y2="8"
                  stroke="#58a6ff"
                  strokeOpacity="0.4"
                  strokeWidth="1"
                />
                <line
                  x1="14"
                  y1="14"
                  x2="22"
                  y2="6"
                  stroke="#a371f7"
                  strokeOpacity="0.4"
                  strokeWidth="1"
                />
                <line
                  x1="14"
                  y1="14"
                  x2="26"
                  y2="16"
                  stroke="#3fb950"
                  strokeOpacity="0.4"
                  strokeWidth="1"
                />
                <line
                  x1="14"
                  y1="14"
                  x2="20"
                  y2="26"
                  stroke="#f778ba"
                  strokeOpacity="0.4"
                  strokeWidth="1"
                />
                <line
                  x1="14"
                  y1="14"
                  x2="6"
                  y2="22"
                  stroke="#d29922"
                  strokeOpacity="0.4"
                  strokeWidth="1"
                />
                <circle cx="6" cy="8" r="2" fill="#58a6ff" />
                <circle cx="22" cy="6" r="2.5" fill="#a371f7" />
                <circle cx="26" cy="16" r="2" fill="#3fb950" />
                <circle cx="20" cy="26" r="3" fill="#f778ba" />
                <circle cx="6" cy="22" r="2" fill="#d29922" />
                <circle cx="14" cy="14" r="5" fill="url(#railCoreGrad)" />
                <circle cx="14" cy="14" r="2" fill="#fff" />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">AgentPane</TooltipContent>
        </Tooltip>

        {/* Divider */}
        <div className="my-1 h-px w-6 bg-border" />
      </div>

      {/* Middle section: Quick-access nav icons */}
      <div className="flex flex-col items-center gap-0.5 py-1">
        {railNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentPath.startsWith(item.matchPrefix);
          return (
            <Tooltip key={item.label}>
              <TooltipTrigger asChild>
                <Link
                  to={item.to}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-md transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                    isActive
                      ? 'bg-surface-emphasis text-fg'
                      : 'text-fg-subtle hover:bg-surface-subtle hover:text-fg-muted'
                  )}
                  data-testid={`rail-nav-${item.label.toLowerCase()}`}
                >
                  {isActive && (
                    <div className="absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent shadow-[0_0_8px_rgba(34,211,238,0.19)]" />
                  )}
                  <Icon size={18} weight={isActive ? 'fill' : 'regular'} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom section: Health + Settings + User avatar */}
      <div className="flex flex-col items-center gap-1 border-t border-border-subtle pb-3 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex h-9 w-9 items-center justify-center"
              data-testid="rail-health-status"
            >
              <div
                className={cn(
                  'h-2 w-2 rounded-full',
                  isHealthy
                    ? 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                    : 'bg-warning shadow-[0_0_6px_rgba(234,179,8,0.4)]'
                )}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {isHealthy ? 'All systems healthy' : 'System unhealthy'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/settings"
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-md transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                currentPath.startsWith('/settings')
                  ? 'bg-surface-emphasis text-fg'
                  : 'text-fg-subtle hover:bg-surface-subtle hover:text-fg-muted'
              )}
              data-testid="rail-nav-settings"
            >
              {currentPath.startsWith('/settings') && (
                <div className="absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent shadow-[0_0_8px_rgba(34,211,238,0.19)]" />
              )}
              <Gear size={18} weight={currentPath.startsWith('/settings') ? 'fill' : 'regular'} />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-success to-accent text-[11px] font-bold text-white transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] cursor-pointer border-2 border-transparent hover:border-accent"
              data-testid="rail-user-avatar"
            >
              SL
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Simon Lynch</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
