import { ArrowLeft, PencilSimple, Spinner, Trash } from '@phosphor-icons/react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { WorkflowDesigner } from '@/app/components/features/workflow-designer';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { Workflow } from '@/db/schema';

export const Route = createFileRoute('/catalog/$workflowId')({
  loader: async ({ params }: { params: { workflowId: string } }) => {
    try {
      const response = await fetch(`/api/workflows/${params.workflowId}`);
      const result = await response.json();
      return { workflow: result.ok ? result.data : null };
    } catch {
      return { workflow: null };
    }
  },
  component: WorkflowDetailPage,
});

/**
 * Workflow detail page component
 * Displays a single workflow in read-only mode using the WorkflowDesigner component
 */
function WorkflowDetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { workflowId } = Route.useParams();
  const loaderData = Route.useLoaderData() as { workflow: Workflow | null } | undefined;
  const [workflow, setWorkflow] = useState<Workflow | null>(
    () => (loaderData?.workflow as Workflow) ?? null
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.workflow);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch workflow from API
  const fetchWorkflow = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/workflows/${workflowId}`);
      const result = await response.json();

      if (result.ok) {
        setWorkflow(result.data);
      } else {
        setError({
          message: result.error?.message ?? 'Failed to load workflow',
          code: result.error?.code,
        });
      }
    } catch (err) {
      console.error('[WorkflowDetail] Fetch error:', err);
      setError({
        message: err instanceof Error ? err.message : 'Failed to load workflow',
      });
    } finally {
      setIsLoading(false);
    }
  }, [workflowId]);

  // Load workflow on mount
  useWatchEffect(() => {
    if (loaderData?.workflow) return;
    fetchWorkflow();
  }, [fetchWorkflow, loaderData]);

  // Handle navigate back to catalog
  const handleBack = useCallback(() => {
    navigate({ to: '/catalog' });
  }, [navigate]);

  // Handle edit workflow (navigate to designer with workflow ID)
  const handleEdit = useCallback(() => {
    navigate({ to: '/designer', search: { id: workflowId } });
  }, [navigate, workflowId]);

  // Handle delete workflow with confirmation
  const handleDelete = useCallback(async () => {
    if (!workflow) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete "${workflow.name}"? This action cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    setIsDeleting(true);

    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        method: 'DELETE',
      });

      // DELETE returns 204 No Content on success
      if (response.status === 204 || response.ok) {
        // Navigate back to catalog after successful deletion
        navigate({ to: '/catalog' });
      } else {
        const result = await response.json();
        setError({
          message: result.error?.message ?? 'Failed to delete workflow',
          code: result.error?.code,
        });
      }
    } catch (err) {
      console.error('[WorkflowDetail] Delete error:', err);
      setError({
        message: err instanceof Error ? err.message : 'Failed to delete workflow',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [workflow, workflowId, navigate]);

  // Loading state
  if (isLoading) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Workflow Catalog', to: '/catalog' }, { label: 'Loading...' }]}
      >
        <div className="flex items-center justify-center min-h-[60vh]" data-testid="loading-state">
          <div className="flex items-center gap-2 text-fg-muted">
            <Spinner className="h-5 w-5 animate-spin" />
            Loading workflow...
          </div>
        </div>
      </LayoutShell>
    );
  }

  // Error state (including 404)
  if (error) {
    const is404 = error.code === 'NOT_FOUND' || error.message.includes('not found');

    return (
      <LayoutShell
        breadcrumbs={[
          { label: 'Workflow Catalog', to: '/catalog' },
          { label: is404 ? 'Not Found' : 'Error' },
        ]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <EmptyState
            preset={is404 ? 'no-results' : 'error'}
            title={is404 ? 'Workflow Not Found' : 'Failed to Load Workflow'}
            subtitle={
              is404
                ? 'The workflow you are looking for does not exist or has been deleted.'
                : error.message
            }
            primaryAction={{
              label: 'Back to Catalog',
              onClick: handleBack,
            }}
            secondaryAction={
              !is404
                ? {
                    label: 'Try Again',
                    onClick: fetchWorkflow,
                  }
                : undefined
            }
          />
        </div>
      </LayoutShell>
    );
  }

  // Workflow not found (fallback)
  if (!workflow) {
    return (
      <LayoutShell
        breadcrumbs={[{ label: 'Workflow Catalog', to: '/catalog' }, { label: 'Not Found' }]}
      >
        <div className="flex items-center justify-center min-h-[60vh]">
          <EmptyState
            preset="no-results"
            title="Workflow Not Found"
            subtitle="The workflow you are looking for does not exist or has been deleted."
            primaryAction={{
              label: 'Back to Catalog',
              onClick: handleBack,
            }}
          />
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Workflow Catalog', to: '/catalog' }, { label: workflow.name }]}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleBack} data-testid="back-button">
            <ArrowLeft className="h-4 w-4" />
            Back to Catalog
          </Button>
          <Button variant="outline" onClick={handleEdit} data-testid="edit-button">
            <PencilSimple className="h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={isDeleting}
            className="text-danger hover:text-danger hover:bg-danger/10 hover:border-danger/50"
            data-testid="delete-button"
          >
            {isDeleting ? (
              <Spinner className="h-4 w-4 animate-spin" />
            ) : (
              <Trash className="h-4 w-4" />
            )}
            Delete
          </Button>
        </div>
      }
    >
      <div className="h-full w-full" data-testid="workflow-detail-page">
        <WorkflowDesigner initialWorkflow={workflow} readOnly={true} />
      </div>
    </LayoutShell>
  );
}
