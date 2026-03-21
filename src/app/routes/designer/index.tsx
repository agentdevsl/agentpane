import { Spinner } from '@phosphor-icons/react';
import { createFileRoute, useSearch } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { WorkflowDesigner } from '@/app/components/features/workflow-designer';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { Workflow } from '@/db/schema';

export const Route = createFileRoute('/designer/')({
  component: DesignerPage,
});

/**
 * Designer page route component
 * Renders the WorkflowDesigner for creating and editing agent workflows
 * Supports loading an existing workflow via ?id=<workflowId> query param
 */
function DesignerPage(): React.JSX.Element {
  // Get search params from URL (using type assertion since TanStack Router types may not be generated yet)
  const search = useSearch({ from: '/designer/' }) as { id?: string };
  const workflowId = search.id;
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [isLoading, setIsLoading] = useState(!!workflowId);
  const [error, setError] = useState<string | null>(null);

  // Fetch workflow if ID is provided
  const fetchWorkflow = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/workflows/${id}`);
      const result = await response.json();

      if (result.ok) {
        setWorkflow(result.data);
      } else {
        setError(result.error?.message ?? 'Failed to load workflow');
      }
    } catch (err) {
      console.error('[Designer] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load workflow');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useWatchEffect(() => {
    if (workflowId) {
      fetchWorkflow(workflowId);
    }
  }, [workflowId, fetchWorkflow]);

  // Loading state when fetching existing workflow
  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Workflow Designer' }]}>
        <div className="flex items-center justify-center min-h-[60vh]" data-testid="loading-state">
          <div className="flex items-center gap-2 text-fg-muted">
            <Spinner className="h-5 w-5 animate-spin" />
            Loading workflow...
          </div>
        </div>
      </LayoutShell>
    );
  }

  // Error state when workflow fetch fails
  if (error && workflowId) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Workflow Designer' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <EmptyState
            preset="error"
            title="Failed to Load Workflow"
            subtitle={error}
            primaryAction={{
              label: 'Try Again',
              onClick: () => fetchWorkflow(workflowId),
            }}
            secondaryAction={{
              label: 'Create New Workflow',
              onClick: () => {
                setError(null);
                setWorkflow(null);
              },
            }}
          />
        </div>
      </LayoutShell>
    );
  }

  const breadcrumbLabel = workflow ? `Edit: ${workflow.name}` : 'Workflow Designer';

  return (
    <LayoutShell breadcrumbs={[{ label: breadcrumbLabel }]}>
      <div className="h-full w-full" data-testid="designer-page">
        <WorkflowDesigner initialWorkflow={workflow ?? undefined} />
      </div>
    </LayoutShell>
  );
}
