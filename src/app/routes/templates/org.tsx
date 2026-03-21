import { Buildings, Plus, Spinner } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import {
  AddTemplateDialog,
  type CreateTemplateInput,
} from '@/app/components/features/add-template-dialog';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { TemplateCard } from '@/app/components/features/template-card';
import { Button } from '@/app/components/ui/button';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import type { Template } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

export const Route = createFileRoute('/templates/org')({
  component: OrgTemplatesPage,
});

function OrgTemplatesPage(): React.JSX.Element {
  // Data state
  const [templates, setTemplates] = useState<Template[]>([]);

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncingTemplateIds, setSyncingTemplateIds] = useState<Set<string>>(new Set());

  // GitHub state
  const [isGitHubConfigured, setIsGitHubConfigured] = useState(false);

  // Fetch org templates and check GitHub status on mount
  useMountEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);

      // Fetch templates and GitHub status in parallel
      const [templatesResult, healthResult] = await Promise.all([
        apiClient.templates.list({ scope: 'org' }),
        apiClient.system.health(),
      ]);

      if (templatesResult.ok) {
        setTemplates(templatesResult.data.items as Template[]);
      }

      if (healthResult.ok) {
        setIsGitHubConfigured(healthResult.data.checks.github.status === 'ok');
      }

      setIsLoading(false);
    };
    fetchData();
  });

  // GitHub callbacks
  const handleFetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    const result = await apiClient.github.listOrgs();
    return result.ok ? result.data.orgs : [];
  }, []);

  const handleFetchReposForOwner = useCallback(async (owner: string): Promise<GitHubRepo[]> => {
    const result = await apiClient.github.listReposForOwner(owner);
    return result.ok ? result.data.repos : [];
  }, []);

  // Handle add template
  const handleAddTemplate = async (data: CreateTemplateInput): Promise<void> => {
    const result = await apiClient.templates.create(data);
    if (!result.ok) {
      throw new Error('Failed to create template');
    }
    // Refresh templates list
    const listResult = await apiClient.templates.list({ scope: 'org' });
    if (listResult.ok) {
      setTemplates(listResult.data.items as Template[]);
    }
  };

  // Handle sync template
  const handleSync = async (templateId: string): Promise<void> => {
    setSyncingTemplateIds((prev) => new Set(prev).add(templateId));
    try {
      await apiClient.templates.sync(templateId);
      // Refresh templates to get updated sync status
      const result = await apiClient.templates.list({ scope: 'org' });
      if (result.ok) {
        setTemplates(result.data.items as Template[]);
      }
    } finally {
      setSyncingTemplateIds((prev) => {
        const next = new Set(prev);
        next.delete(templateId);
        return next;
      });
    }
  };

  // Handle edit template (placeholder - would open edit dialog)
  const handleEdit = (_templateId: string): void => {
    // TODO: [CQ-018] Implement edit dialog
    console.log('Edit template:', _templateId);
  };

  // Handle delete template
  const handleDelete = async (templateId: string): Promise<void> => {
    const confirmed = window.confirm('Are you sure you want to delete this template?');
    if (!confirmed) return;

    const result = await apiClient.templates.delete(templateId);
    if (result.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== templateId));
    } else {
      console.error('[OrgTemplates] Failed to delete template:', result.error);
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Templates' }, { label: 'Organization Templates' }]}>
        <div className="flex items-center justify-center min-h-[60vh]" data-testid="loading-state">
          <div className="flex items-center gap-2 text-fg-muted">
            <Spinner className="h-5 w-5 animate-spin" />
            Loading templates...
          </div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Templates' }, { label: 'Organization Templates' }]}
      actions={
        <Button onClick={() => setShowAddDialog(true)} data-testid="add-template-button">
          <Plus className="h-4 w-4" />
          Add Template
        </Button>
      }
    >
      <div data-testid="org-templates-page" className="p-6">
        {templates.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60vh]">
            <EmptyState
              icon={Buildings}
              title="No Organization Templates"
              subtitle="Organization templates are shared across all projects. Add templates to provide default skills, commands, and agent configurations."
              primaryAction={{
                label: 'Add Template',
                onClick: () => setShowAddDialog(true),
              }}
            />
          </div>
        ) : (
          <div
            className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
            data-testid="template-grid"
          >
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onSync={() => handleSync(template.id)}
                onEdit={() => handleEdit(template.id)}
                onDelete={() => handleDelete(template.id)}
                isSyncing={syncingTemplateIds.has(template.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Template Dialog */}
      <AddTemplateDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        scope="org"
        onSubmit={handleAddTemplate}
        onFetchOrgs={handleFetchOrgs}
        onFetchReposForOwner={handleFetchReposForOwner}
        isGitHubConfigured={isGitHubConfigured}
      />
    </LayoutShell>
  );
}
