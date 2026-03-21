import type { ReactNode } from 'react';
import { type BreadcrumbItem, Breadcrumbs } from '@/app/components/features/breadcrumbs';
import { FolderRail } from '@/app/components/features/folder-rail';
import { Sidebar } from '@/app/components/features/sidebar';

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
  children: ReactNode;
}

export function LayoutShell({
  breadcrumbs,
  codespaceId,
  codespaceName,
  codespacePath,
  projectId,
  projectName,
  projectPath,
  actions,
  centerAction,
  header,
  children,
}: LayoutShellProps): React.JSX.Element {
  // Support both old and new prop names during migration
  const resolvedCodespaceId = codespaceId ?? projectId;
  const resolvedCodespaceName = codespaceName ?? projectName;
  const resolvedCodespacePath = codespacePath ?? projectPath;

  return (
    <div className="flex h-screen bg-canvas text-fg" data-testid="layout-shell">
      {/* Folder rail - always visible on md+ screens */}
      <div className="hidden h-full md:flex">
        <FolderRail />
      </div>
      {/* Collapsible sidebar */}
      <div className="hidden h-full md:flex">
        <Sidebar
          codespaceId={resolvedCodespaceId}
          codespaceName={resolvedCodespaceName}
          codespacePath={resolvedCodespacePath}
        />
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
        <main className="flex flex-1 flex-col min-h-0 overflow-hidden" data-testid="layout-main">
          {children}
        </main>
      </div>
    </div>
  );
}
