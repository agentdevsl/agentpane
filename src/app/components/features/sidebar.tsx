import {
  CaretUpDown,
  Clock,
  Cube,
  Files,
  FolderOpen,
  Gear,
  GitFork,
  GridFour,
  Hourglass,
  Kanban,
  Lightning,
  Plus,
  PuzzlePiece,
  Robot,
  Terminal,
  TreeStructure,
} from '@phosphor-icons/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectContext } from '@/app/providers/project-context';
import { apiClient } from '@/lib/api/client';

interface SidebarProps {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
}

interface NavItem {
  readonly label: string;
  readonly to: string;
  readonly icon: typeof Robot;
  readonly badge?: number | 'active' | string;
  readonly badgeVariant?: 'success' | 'warning' | 'info';
  readonly testId?: string;
}

// ORGANIZATION section - app-wide navigation (not project-specific)
const organizationNavItems: readonly NavItem[] = [
  { label: 'Projects', to: '/projects', icon: Kanban, testId: 'nav-projects' },
  { label: 'Sessions', to: '/sessions', icon: Clock, testId: 'nav-sessions' },
  { label: 'CLI Monitor', to: '/cli-monitor', icon: Terminal, testId: 'nav-cli-monitor' },
] as const;

// CONTENT section - organization-wide templates, workflows, and marketplace
// Marketplace syncs with: https://github.com/anthropics/claude-plugins-official
//   - /plugins (internal Anthropic plugins)
//   - /external_plugins (third-party community plugins)
const contentNavItems: readonly NavItem[] = [
  { label: 'Org Templates', to: '/templates/org', icon: Files, testId: 'nav-org-templates' },
  { label: 'Designer', to: '/designer', icon: TreeStructure, testId: 'nav-designer' },
  { label: 'Catalog', to: '/catalog', icon: GridFour, testId: 'nav-catalog' },
  { label: 'Marketplace', to: '/marketplace', icon: PuzzlePiece, testId: 'nav-marketplace' },
  { label: 'Terraform', to: '/terraform', icon: Cube, testId: 'nav-terraform' },
] as const;

// AUTOMATION section - event sources and subscriptions
const automationNavItems: readonly NavItem[] = [
  { label: 'Events', to: '/events', icon: Lightning, testId: 'nav-events' },
] as const;

// EXECUTION section - runtime and sandbox configuration
const executionNavItems: readonly NavItem[] = [
  { label: 'Sandbox Configs', to: '/settings/sandbox', icon: Cube, testId: 'nav-sandbox-configs' },
] as const;

// Admin section nav items are now dynamic based on health status

export function Sidebar({ projectId: _projectId }: SidebarProps): React.JSX.Element {
  const { currentProject, openPicker } = useProjectContext();
  const navigate = useNavigate();
  const [isHealthy, setIsHealthy] = useState(true);
  const [dbMode, setDbMode] = useState<string>('sqlite');
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle click with delay to distinguish from double-click
  const handleProjectClick = useCallback(() => {
    // Clear any existing timeout
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    // Set a short delay before opening picker to allow double-click detection
    clickTimeoutRef.current = setTimeout(() => {
      openPicker();
    }, 200);
  }, [openPicker]);

  // Double-click navigates to the current project
  const handleProjectDoubleClick = useCallback(() => {
    // Cancel the single-click timeout
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    if (currentProject) {
      navigate({ to: '/projects/$projectId', params: { projectId: currentProject.project.id } });
    }
  }, [currentProject, navigate]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  // Check system health periodically
  useEffect(() => {
    const checkHealth = async () => {
      const result = await apiClient.system.health();
      setIsHealthy(result.ok && result.data.status === 'healthy');
      if (result.ok && result.data.checks.database.mode) {
        setDbMode(result.data.checks.database.mode);
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Check every 30 seconds
    return () => clearInterval(interval);
  }, []);

  // Admin nav items
  const adminNavItems: NavItem[] = [
    {
      label: 'Settings',
      to: '/settings',
      icon: Gear,
      testId: 'nav-settings',
    },
  ];

  return (
    <aside
      className="flex h-full w-60 flex-col border-r border-border bg-surface"
      data-testid="sidebar"
    >
      {/* Header with logo */}
      <Link
        to="/"
        className="flex items-center gap-2.5 px-4 py-4 transition-colors hover:bg-surface-subtle"
      >
        <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-surface-subtle shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_-1px_0_0_rgba(0,0,0,0.3)_inset,0_4px_16px_-2px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
          <div className="absolute inset-0 animate-pulse rounded-xl bg-gradient-radial from-done/10 to-transparent dark:from-done/15" />
          <svg
            className="relative z-10 h-7 w-7 drop-shadow-[0_0_8px_rgba(163,113,247,0.4)]"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#fff" />
                <stop offset="50%" stopColor="#3fb950" />
                <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* Connection lines */}
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
            {/* Outer nodes */}
            <circle
              className="animate-pulse"
              cx="6"
              cy="8"
              r="2"
              fill="#58a6ff"
              style={{ filter: 'drop-shadow(0 0 2px #58a6ff)' }}
            />
            <circle
              className="animate-pulse"
              cx="22"
              cy="6"
              r="2.5"
              fill="#a371f7"
              style={{ filter: 'drop-shadow(0 0 3px #a371f7)', animationDelay: '0.4s' }}
            />
            <circle
              className="animate-pulse"
              cx="26"
              cy="16"
              r="2"
              fill="#3fb950"
              style={{ filter: 'drop-shadow(0 0 2px #3fb950)', animationDelay: '0.8s' }}
            />
            <circle
              className="animate-pulse"
              cx="20"
              cy="26"
              r="3"
              fill="#f778ba"
              style={{ filter: 'drop-shadow(0 0 3px #f778ba)', animationDelay: '1.2s' }}
            />
            <circle
              className="animate-pulse"
              cx="6"
              cy="22"
              r="2"
              fill="#d29922"
              style={{ filter: 'drop-shadow(0 0 2px #d29922)', animationDelay: '1.6s' }}
            />
            {/* Center hub */}
            <circle cx="14" cy="14" r="5" fill="url(#coreGrad)" />
            <circle cx="14" cy="14" r="2" fill="#fff" />
          </svg>
        </div>
        <span className="text-[15px] font-semibold text-fg">AgentPane</span>
      </Link>

      {/* Current project card - click opens picker, double-click navigates to project */}
      <div className="mx-3 mt-3 flex flex-col gap-1.5" data-testid="project-list">
        {currentProject ? (
          <button
            type="button"
            onClick={handleProjectClick}
            onDoubleClick={handleProjectDoubleClick}
            className="flex items-center gap-2.5 rounded-md border border-accent bg-accent-muted p-2.5 text-left transition-colors hover:bg-accent-muted/80"
            data-testid="project-card"
            title="Click to switch projects, double-click to open"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-success to-accent text-[11px] font-semibold text-white">
              {currentProject.project.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg">
                {currentProject.project.name}
              </div>
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                {currentProject.runningAgents.length > 0 && (
                  <span className="flex items-center gap-1 text-success">
                    <Robot className="h-3 w-3" />
                    {currentProject.runningAgents.length}
                  </span>
                )}
                <span data-testid="project-status">{currentProject.taskCounts.total} tasks</span>
              </div>
            </div>
            <CaretUpDown className="h-4 w-4 flex-shrink-0 text-fg-muted" />
          </button>
        ) : (
          <button
            type="button"
            onClick={openPicker}
            className="flex items-center gap-2.5 rounded-md border border-dashed border-border bg-surface-subtle p-2.5 text-sm text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg"
            data-testid="project-card"
          >
            <Plus className="h-4 w-4" />
            <span className="flex-1 text-left">Select a project</span>
            <CaretUpDown className="h-4 w-4 flex-shrink-0" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="mt-4 flex-1 overflow-y-auto px-3">
        {/* ORGANIZATION section - app-wide navigation */}
        <NavSection title="Organization" testId="nav-section-organization">
          {organizationNavItems.map((item) => (
            <NavLink key={item.label} item={item} />
          ))}
        </NavSection>

        {/* PROJECT section - only shown when a project is selected */}
        {currentProject && (
          <NavSection title="Project" testId="nav-section-project">
            {/* Tasks - links to selected project's kanban */}
            <Link
              to="/projects/$projectId"
              params={{ projectId: currentProject.project.id }}
              activeOptions={{ exact: true }}
              activeProps={{ className: 'bg-accent-muted text-accent' }}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
              data-testid="nav-tasks"
            >
              <Kanban className="h-4 w-4 opacity-80" />
              Tasks
            </Link>
            {/* Git - links to selected project's git management */}
            <Link
              to="/projects/$projectId/git"
              params={{ projectId: currentProject.project.id }}
              activeProps={{ className: 'bg-accent-muted text-accent' }}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
              data-testid="nav-git"
            >
              <GitFork className="h-4 w-4 opacity-80" />
              Git
            </Link>
            {/* Templates - project-specific templates */}
            <Link
              to="/templates/project"
              activeProps={{ className: 'bg-accent-muted text-accent' }}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
              data-testid="nav-project-templates"
            >
              <FolderOpen className="h-4 w-4 opacity-80" />
              Templates
            </Link>
            {/* Queue - project task queue */}
            <Link
              to="/queue"
              activeProps={{ className: 'bg-accent-muted text-accent' }}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
              data-testid="nav-queue"
            >
              <Hourglass className="h-4 w-4 opacity-80" />
              Queue
            </Link>
          </NavSection>
        )}

        {/* CONTENT section - organization-wide templates */}
        <NavSection title="Content" testId="nav-section-content">
          {contentNavItems.map((item) => (
            <NavLink key={item.label} item={item} />
          ))}
        </NavSection>

        {/* AUTOMATION section - event handling */}
        <NavSection title="Automation" testId="nav-section-automation">
          {automationNavItems.map((item) => (
            <NavLink key={item.label} item={item} />
          ))}
        </NavSection>

        {/* EXECUTION section - sandbox configuration */}
        <NavSection title="Execution" testId="nav-section-execution">
          {executionNavItems.map((item) => (
            <NavLink key={item.label} item={item} />
          ))}
        </NavSection>

        {/* ADMIN section */}
        <NavSection title="Admin" testId="nav-section-admin">
          {adminNavItems.map((item) => (
            <NavLink key={item.label} item={item} />
          ))}
        </NavSection>
      </nav>

      {/* System Status */}
      <div data-testid="system-status" className="border-t border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${isHealthy ? 'bg-success' : 'bg-warning'}`}
            data-testid="health-indicator"
          />
          <span className="text-xs text-fg-muted">
            {isHealthy ? 'System healthy' : 'System unhealthy'}
          </span>
        </div>
      </div>

      {/* Footer */}
      <div data-testid="sidebar-footer" className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div
            data-testid="user-avatar"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-success to-accent text-xs font-medium text-white"
          >
            SL
          </div>
          <div className="flex-1">
            <div data-testid="user-name" className="text-sm font-medium text-fg">
              Simon Lynch
            </div>
            <div data-testid="mode-indicator" className="text-xs text-fg-muted">
              {dbMode === 'postgres' ? 'PostgreSQL mode' : 'Local-first mode'}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-4" data-testid={testId}>
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavLink({ item }: { item: NavItem }): React.JSX.Element {
  const Icon = item.icon;

  const getBadgeClasses = () => {
    if (item.badgeVariant === 'warning') {
      return 'bg-attention-muted text-attention';
    }
    if (item.badgeVariant === 'success' || item.badge === 'active') {
      return 'bg-success-muted text-success';
    }
    if (item.badgeVariant === 'info') {
      return 'bg-accent-muted text-accent';
    }
    return 'bg-surface-emphasis text-fg-muted';
  };

  return (
    <Link
      to={item.to}
      activeProps={{
        className: 'bg-accent-muted text-accent',
        'data-active': 'true',
      }}
      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
      data-testid={item.testId}
    >
      <Icon className="h-4 w-4 opacity-80" />
      {item.label}
      {item.badge !== undefined && (
        <span
          className={`ml-auto flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium ${getBadgeClasses()}`}
        >
          {item.badge === 'active' ? '3' : item.badge}
        </span>
      )}
    </Link>
  );
}
