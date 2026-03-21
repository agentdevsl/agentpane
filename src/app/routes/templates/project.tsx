import { CaretDown, Files, Plus, Spinner } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AddTemplateDialog,
  type CreateTemplateInput,
} from '@/app/components/features/add-template-dialog';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { TemplateCard } from '@/app/components/features/template-card';
import { Button } from '@/app/components/ui/button';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { Template } from '@/db/schema';
import { apiClient, type CodespaceListItem } from '@/lib/api/client';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

export const Route = createFileRoute('/templates/project')({
  component: ProjectTemplatesPage,
});

function TemplateGrid({
  templates,
  onSync,
  onEdit,
  onDelete,
  syncingTemplateIds,
}: {
  templates: Template[];
  onSync: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  syncingTemplateIds: Set<string>;
}): React.JSX.Element {
  return (
    <div
      className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
      data-testid="template-grid"
    >
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          onSync={() => onSync(template.id)}
          onEdit={() => onEdit(template.id)}
          onDelete={() => onDelete(template.id)}
          isSyncing={syncingTemplateIds.has(template.id)}
        />
      ))}
    </div>
  );
}

function ProjectTemplatesPage(): React.JSX.Element {
  // Data state
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<CodespaceListItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | 'all'>('all');

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncingTemplateIds, setSyncingTemplateIds] = useState<Set<string>>(new Set());
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  // GitHub state
  const [isGitHubConfigured, setIsGitHubConfigured] = useState(false);

  // Ref for dropdown click-outside handling
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click-outside handler for dropdown
  useWatchEffect(() => {
    if (!showProjectDropdown) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowProjectDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside, { passive: true });
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showProjectDropdown]);

  // Fetch codespaces and GitHub status on mount
  useMountEffect(() => {
    const fetchInitialData = async () => {
      const [codespacesResult, healthResult] = await Promise.all([
        apiClient.codespaces.list({ limit: 100 }),
        apiClient.system.health(),
      ]);

      if (codespacesResult.ok) {
        setProjects(codespacesResult.data.items);
      }

      if (healthResult.ok) {
        setIsGitHubConfigured(healthResult.data.checks.github.status === 'ok');
      }
    };
    fetchInitialData();
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

  // Fetch templates
  useWatchEffect(() => {
    const fetchTemplates = async () => {
      setIsLoading(true);
      const options: { scope: 'codespace'; codespaceId?: string } = { scope: 'codespace' };
      if (selectedProjectId !== 'all') {
        options.codespaceId = selectedProjectId;
      }
      const result = await apiClient.templates.list(options);
      if (result.ok) {
        setTemplates(result.data.items as Template[]);
      }
      setIsLoading(false);
    };
    fetchTemplates();
  }, [selectedProjectId]);

  // Filter templates by selected project
  const filteredTemplates = useMemo(() => {
    if (selectedProjectId === 'all') {
      return templates;
    }
    return templates.filter((t) => t.codespaceId === selectedProjectId);
  }, [templates, selectedProjectId]);

  // Group templates by codespace for "all" view
  const groupedTemplates = useMemo(() => {
    if (selectedProjectId !== 'all') {
      return null;
    }
    const groups: Map<string, { project: CodespaceListItem | null; templates: Template[] }> =
      new Map();

    for (const template of templates) {
      const csId = template.codespaceId ?? 'unknown';
      if (!groups.has(csId)) {
        const project = projects.find((p) => p.id === csId) ?? null;
        groups.set(csId, { project, templates: [] });
      }
      groups.get(csId)?.templates.push(template);
    }

    return groups;
  }, [templates, projects, selectedProjectId]);

  // Get selected project name
  const selectedProjectName = useMemo(() => {
    if (selectedProjectId === 'all') return 'All Projects';
    return projects.find((p) => p.id === selectedProjectId)?.name ?? 'Select Project';
  }, [selectedProjectId, projects]);

  // Handle add template
  const handleAddTemplate = async (data: CreateTemplateInput): Promise<void> => {
    const result = await apiClient.templates.create(data);
    if (!result.ok) {
      throw new Error('Failed to create template');
    }
    // Refresh templates list
    const listResult = await apiClient.templates.list({
      scope: 'codespace',
      codespaceId: selectedProjectId === 'all' ? undefined : selectedProjectId,
    });
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
      const result = await apiClient.templates.list({
        scope: 'codespace',
        codespaceId: selectedProjectId === 'all' ? undefined : selectedProjectId,
      });
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
      console.error('[ProjectTemplates] Failed to delete template:', result.error);
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Templates' }, { label: 'Project Templates' }]}>
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
      breadcrumbs={[{ label: 'Templates' }, { label: 'Project Templates' }]}
      actions={
        <div className="flex items-center gap-3">
          {/* Project filter dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setShowProjectDropdown(!showProjectDropdown)}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-subtle"
              data-testid="project-filter"
            >
              <Files className="h-4 w-4 text-fg-muted" />
              <span>{selectedProjectName}</span>
              <CaretDown className="h-4 w-4 text-fg-muted" />
            </button>
            {showProjectDropdown ? (
              <div
                className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-md border border-border bg-surface py-1 shadow-lg"
                data-testid="project-dropdown"
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProjectId('all');
                    setShowProjectDropdown(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-surface-subtle ${
                    selectedProjectId === 'all' ? 'bg-accent-muted text-accent' : 'text-fg'
                  }`}
                >
                  All Projects
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setShowProjectDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-surface-subtle ${
                      selectedProjectId === project.id ? 'bg-accent-muted text-accent' : 'text-fg'
                    }`}
                  >
                    {project.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <Button
            onClick={() => setShowAddDialog(true)}
            disabled={selectedProjectId === 'all' && projects.length === 0}
            data-testid="add-template-button"
          >
            <Plus className="h-4 w-4" />
            Add Template
          </Button>
        </div>
      }
    >
      <div data-testid="project-templates-page" className="p-6">
        {filteredTemplates.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60vh]">
            <EmptyState
              icon={Files}
              title="No Project Templates"
              subtitle={
                selectedProjectId === 'all'
                  ? 'Add templates to your projects to share configurations, skills, and agents.'
                  : 'Add a template to this project to share configurations with your team.'
              }
              primaryAction={{
                label: 'Add Template',
                onClick: () => setShowAddDialog(true),
              }}
            />
          </div>
        ) : selectedProjectId === 'all' && groupedTemplates ? (
          // Grouped view by project
          <div className="space-y-8" data-testid="grouped-templates">
            {Array.from(groupedTemplates.entries()).map(([projectId, group]) => (
              <div key={projectId} data-testid={`project-group-${projectId}`}>
                <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-fg">
                  <Files className="h-5 w-5 text-fg-muted" />
                  {group.project?.name ?? 'Unknown Project'}
                </h2>
                <TemplateGrid
                  templates={group.templates}
                  onSync={handleSync}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  syncingTemplateIds={syncingTemplateIds}
                />
              </div>
            ))}
          </div>
        ) : (
          // Single project view
          <TemplateGrid
            templates={filteredTemplates}
            onSync={handleSync}
            onEdit={handleEdit}
            onDelete={handleDelete}
            syncingTemplateIds={syncingTemplateIds}
          />
        )}
      </div>

      {/* Add Template Dialog */}
      <AddTemplateDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        scope="codespace"
        initialProjectIds={selectedProjectId !== 'all' ? [selectedProjectId] : []}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        onSubmit={handleAddTemplate}
        onFetchOrgs={handleFetchOrgs}
        onFetchReposForOwner={handleFetchReposForOwner}
        isGitHubConfigured={isGitHubConfigured}
      />
    </LayoutShell>
  );
}
