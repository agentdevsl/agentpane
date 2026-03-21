import {
  CaretLeft,
  CaretRight,
  Files,
  Gear,
  GitFork,
  Kanban,
  Lightning,
  Monitor,
  Plus,
  Users,
} from '@phosphor-icons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import { useCodespaceContext } from '@/app/providers/codespace-context';
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, useFolderData } from '@/app/providers/folder-context';
import { cn } from '@/lib/utils/cn';
import { ResizeHandle } from '../ui/resize-handle';

// =============================================================================
// NavPanel Component (Tier 3)
// =============================================================================

/**
 * NavPanel -- collapsible panel showing codespaces in the selected folder
 * and contextual codespace navigation.
 * Collapses to icon-only (48px) with codespace avatars + nav icons.
 */
export function NavPanel(): React.JSX.Element {
  const {
    selectedFolder,
    isNavPanelOpen,
    toggleNavPanel,
    navPanelWidth,
    setNavPanelWidth,
    persistNavPanelWidth,
  } = useFolderData();
  const { currentCodespace, currentCodespaceId, allCodespaces, selectCodespace, openPicker } =
    useCodespaceContext();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const expanded = isNavPanelOpen;

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col border-r border-border bg-surface overflow-hidden z-10',
        expanded
          ? ''
          : 'w-[48px] min-w-[48px] transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]'
      )}
      style={expanded ? { width: navPanelWidth, minWidth: MIN_PANEL_WIDTH } : undefined}
      data-testid="nav-panel"
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center min-h-[52px] border-b border-border-subtle',
          expanded ? 'gap-2 px-3.5 py-3' : 'justify-center py-3'
        )}
      >
        {expanded ? (
          <>
            <button
              type="button"
              onClick={toggleNavPanel}
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-transparent text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-fg"
              data-testid="nav-panel-back"
              title="Collapse"
            >
              <CaretLeft size={14} />
            </button>
            <div className="flex flex-1 items-center gap-1.5 min-w-0">
              {selectedFolder && (
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: selectedFolder.color }}
                />
              )}
              <h3 className="truncate text-[13px] font-semibold text-fg">
                {selectedFolder?.name ?? 'All Codespaces'}
              </h3>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={toggleNavPanel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-fg"
            data-testid="nav-panel-expand"
            title="Expand"
          >
            <CaretRight size={14} />
          </button>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto pb-2">
        {/* CODESPACES section */}
        <div className={expanded ? 'px-2' : 'px-1'}>
          {expanded && (
            <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
              Codespaces
            </div>
          )}

          {/* Add codespace button */}
          {expanded ? (
            <button
              type="button"
              onClick={openPicker}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-accent mb-0.5"
              data-testid="add-codespace-btn"
            >
              <Plus size={14} />
              Add codespace
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={openPicker}
                  className="flex w-full items-center justify-center rounded-md py-1.5 mt-2 mb-1 text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-accent"
                  data-testid="add-codespace-btn"
                >
                  <Plus size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Add codespace</TooltipContent>
            </Tooltip>
          )}

          {/* Codespace list */}
          {allCodespaces.map((cs) => {
            const isActive = cs.id === currentCodespaceId;
            const initials =
              cs.icon.type === 'initials' ? cs.icon.value : cs.name.slice(0, 2).toUpperCase();
            const gradients: Record<string, string> = {
              blue: 'linear-gradient(135deg, #6366f1, #818cf8)',
              green: 'linear-gradient(135deg, #22c55e, #4ade80)',
              purple: 'linear-gradient(135deg, #a855f7, #c084fc)',
              orange: 'linear-gradient(135deg, #f97316, #fb923c)',
              red: 'linear-gradient(135deg, #ef4444, #f87171)',
            };
            const gradient =
              gradients[cs.icon.type === 'initials' ? cs.icon.color : 'blue'] ?? gradients.blue;
            const hasRunningAgent = cs.stats?.activeAgents && cs.stats.activeAgents > 0;

            const csButton = (
              <button
                key={cs.id}
                type="button"
                onClick={() => selectCodespace(cs)}
                className={cn(
                  'flex items-center rounded-md mb-px text-left transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                  expanded ? 'w-full gap-2 px-2 py-1.5' : 'w-full justify-center py-1.5',
                  isActive ? 'bg-accent/10' : 'hover:bg-surface-subtle'
                )}
                data-testid={`codespace-item-${cs.id}`}
              >
                {/* Avatar */}
                <div
                  className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-[9px] font-bold text-white tracking-wide"
                  style={{ background: gradient }}
                >
                  {initials}
                </div>

                {expanded && (
                  <>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          'truncate text-[13px] font-medium transition-colors duration-[220ms]',
                          isActive ? 'text-fg' : 'text-fg-muted'
                        )}
                      >
                        {cs.name}
                      </div>
                    </div>

                    {/* Status dot */}
                    <div
                      className={cn(
                        'h-[7px] w-[7px] shrink-0 rounded-full',
                        hasRunningAgent
                          ? 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.4)] animate-pulse'
                          : 'bg-fg-subtle'
                      )}
                    />
                  </>
                )}
              </button>
            );

            if (!expanded) {
              return (
                <Tooltip key={cs.id}>
                  <TooltipTrigger asChild>{csButton}</TooltipTrigger>
                  <TooltipContent side="right">{cs.name}</TooltipContent>
                </Tooltip>
              );
            }

            return csButton;
          })}
        </div>

        {/* CODESPACE contextual nav (only when a codespace is selected) */}
        {currentCodespace && (
          <div className={expanded ? 'px-2' : 'px-1'}>
            {expanded && (
              <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                Codespace
              </div>
            )}

            {!expanded && <div className="mx-2 my-1.5 h-px bg-border-subtle" />}

            <NavLink
              to="/codespaces/$codespaceId"
              params={{ codespaceId: currentCodespace.codespace.id }}
              icon={Kanban}
              label="Tasks"
              currentPath={currentPath}
              exact
              badge={currentCodespace.taskCounts?.total}
              collapsed={!expanded}
            />
            <NavLink
              to="/sessions"
              params={{}}
              search={{ codespaceId: currentCodespace.codespace.id }}
              icon={Monitor}
              label="Sessions"
              currentPath={currentPath}
              collapsed={!expanded}
            />
            <NavLink
              to="/codespaces/$codespaceId/git"
              params={{ codespaceId: currentCodespace.codespace.id }}
              icon={GitFork}
              label="Git"
              currentPath={currentPath}
              collapsed={!expanded}
            />
            <NavLink
              to="/codespaces/$codespaceId/worktrees"
              params={{ codespaceId: currentCodespace.codespace.id }}
              icon={Users}
              label="Worktrees"
              currentPath={currentPath}
              collapsed={!expanded}
            />
            <NavLink
              to="/templates/project"
              params={{}}
              icon={Files}
              label="Templates"
              currentPath={currentPath}
              collapsed={!expanded}
            />
            <NavLink
              to="/codespaces/$codespaceId/settings"
              params={{ codespaceId: currentCodespace.codespace.id }}
              icon={Gear}
              label="Settings"
              currentPath={currentPath}
              collapsed={!expanded}
            />
            <NavLink
              to="/events"
              params={{}}
              icon={Lightning}
              label="Events"
              currentPath={currentPath}
              collapsed={!expanded}
            />
          </div>
        )}
      </div>

      {/* Resize handle (expanded only) */}
      {expanded && (
        <ResizeHandle
          currentWidth={navPanelWidth}
          onResize={setNavPanelWidth}
          onResizeEnd={persistNavPanelWidth}
          minWidth={MIN_PANEL_WIDTH}
          maxWidth={MAX_PANEL_WIDTH}
        />
      )}
    </aside>
  );
}

// =============================================================================
// NavLink Sub-component
// =============================================================================

function NavLink({
  to,
  params,
  search,
  icon: Icon,
  label,
  currentPath,
  exact,
  badge,
  collapsed,
}: {
  to: string;
  params: Record<string, string>;
  search?: Record<string, string>;
  icon: typeof Kanban;
  label: string;
  currentPath: string;
  exact?: boolean;
  badge?: number;
  collapsed?: boolean;
}): React.JSX.Element {
  let resolvedPath = to;
  for (const [key, val] of Object.entries(params)) {
    resolvedPath = resolvedPath.replace(`$${key}`, val);
  }
  const isActive = exact ? currentPath === resolvedPath : currentPath.startsWith(resolvedPath);

  const link = (
    <Link
      to={to}
      params={params}
      search={search}
      activeOptions={exact ? { exact: true } : undefined}
      className={cn(
        'flex items-center rounded-md mb-px transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
        collapsed ? 'justify-center py-1.5' : 'gap-2 px-2 py-1.5 text-[13px] font-medium',
        isActive
          ? 'bg-surface-emphasis text-fg'
          : 'text-fg-muted hover:bg-surface-subtle hover:text-fg'
      )}
      data-testid={`nav-link-${label.toLowerCase()}`}
    >
      <Icon
        size={16}
        className={cn('shrink-0 transition-colors', isActive ? 'text-fg-muted' : 'text-fg-subtle')}
      />
      {!collapsed && label}
      {!collapsed && badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'ml-auto text-[10px] font-semibold px-1.5 py-px rounded-[10px] font-mono',
            isActive ? 'bg-accent/10 text-accent' : 'bg-surface-subtle text-fg-subtle'
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}
