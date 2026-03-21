import type { ReactNode } from 'react';
import { type BreadcrumbItem, Breadcrumbs } from '@/app/components/features/breadcrumbs';
import { FolderPanel } from '@/app/components/features/folder-panel';
import { FolderRail } from '@/app/components/features/folder-rail';
import { NavPanel } from '@/app/components/features/nav-panel';
import { ViewTabBar } from '@/app/components/features/view-tab-bar';

interface LayoutShellProps {
  breadcrumbs?: BreadcrumbItem[];
  codespaceId?: string;
  codespaceName?: string;
  codespacePath?: string;
  /** @deprecated Use codespaceId instead */
  projectId?: string;
  /** @deprecated Use codespaceName instead */
  projectName?: string;
  /** @deprecated Use codespacePath instead */
  projectPath?: string;
  /** Actions displayed on the right side of the header */
  actions?: ReactNode;
  /** Action displayed in the center of the header */
  centerAction?: ReactNode;
  /** Custom header element -- when provided, replaces the default breadcrumbs-based header */
  header?: ReactNode;
  /** Show the view tab bar (Codespaces, Kanban Board, Sessions, Settings) */
  showViewTabs?: boolean;
  children: ReactNode;
}

export function LayoutShell({
  breadcrumbs,
  codespaceId: _codespaceId,
  codespaceName: _codespaceName,
  codespacePath: _codespacePath,
  projectId: _projectId,
  projectName: _projectName,
  projectPath: _projectPath,
  actions,
  centerAction,
  header,
  showViewTabs,
  children,
}: LayoutShellProps): React.JSX.Element {
  return (
    <div className="flex h-screen bg-canvas text-fg" data-testid="layout-shell">
      {/* Folder rail - always visible on md+ screens */}
      <div className="hidden h-full shrink-0 md:flex">
        <FolderRail />
      </div>
      {/* Folder panel (Tier 2) - toggleable from org avatar */}
      <div className="hidden h-full shrink-0 md:flex">
        <FolderPanel />
      </div>
      {/* Nav panel (Tier 3) - codespace list + contextual nav */}
      <div className="hidden h-full shrink-0 md:flex">
        <NavPanel />
      </div>
      <div className="flex flex-1 flex-col min-h-0 min-w-0">
        {header && header}
        {!header && breadcrumbs && (
          <header
            className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6 sm:py-4"
            data-testid="layout-header"
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-subtle text-fg-muted md:hidden"
                data-testid="sidebar-toggle"
              >
                <span className="sr-only">Toggle sidebar</span>
                <span className="h-4 w-4">☰</span>
              </button>
              <div>
                <Breadcrumbs items={breadcrumbs} />
              </div>
            </div>
            {centerAction ? (
              <div className="flex justify-center" data-testid="header-center-action">
                {centerAction}
              </div>
            ) : (
              <div />
            )}
            {actions ? (
              <div className="flex items-center justify-end gap-2" data-testid="header-actions">
                {actions}
              </div>
            ) : (
              <div />
            )}
          </header>
        )}
        {showViewTabs && <ViewTabBar />}
        <main className="flex flex-1 flex-col min-h-0 overflow-hidden" data-testid="layout-main">
          {children}
        </main>
      </div>
    </div>
  );
}
