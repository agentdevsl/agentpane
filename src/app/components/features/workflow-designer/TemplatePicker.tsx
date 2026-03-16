import { Code, Folder, Lightning, Robot, Spinner, Terminal } from '@phosphor-icons/react';
import { useMemo } from 'react';
import type { Template } from '@/db/schema';
import { cn } from '@/lib/utils/cn';

interface TemplatePickerProps {
  templates: Template[];
  selectedTemplateId?: string;
  onSelectTemplate: (template: Template) => void;
  isLoading?: boolean;
  className?: string;
}

interface TemplateItemProps {
  template: Template;
  isSelected: boolean;
  onSelect: () => void;
}

function TemplateItem({ template, isSelected, onSelect }: TemplateItemProps): React.JSX.Element {
  const skillCount = (template.cachedSkills ?? []).length;
  const commandCount = (template.cachedCommands ?? []).length;
  const agentCount = (template.cachedAgents ?? []).length;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-lg border bg-surface p-4 transition-all duration-150',
        'hover:border-fg-subtle hover:shadow-sm',
        'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2',
        isSelected ? 'border-accent bg-accent-muted/30 ring-1 ring-accent' : 'border-border'
      )}
      data-testid="template-picker-item"
      data-template-id={template.id}
      aria-pressed={isSelected}
    >
      <div className="flex items-start gap-3">
        {/* Scope icon */}
        <div
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg shrink-0',
            template.scope === 'org' ? 'bg-secondary-muted' : 'bg-accent-muted'
          )}
        >
          {template.scope === 'org' ? (
            <Folder className="h-5 w-5 text-secondary" weight="fill" />
          ) : (
            <Code className="h-5 w-5 text-accent" weight="fill" />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-fg truncate">{template.name}</h3>
            <span
              className={cn(
                'shrink-0 inline-flex items-center h-5 px-2 rounded-full text-[10px] font-medium uppercase tracking-wide',
                template.scope === 'org'
                  ? 'bg-secondary-muted text-secondary'
                  : 'bg-accent-muted text-accent'
              )}
            >
              {template.scope}
            </span>
          </div>

          {template.description && (
            <p className="mt-1 text-xs text-fg-muted line-clamp-2">{template.description}</p>
          )}

          {/* Counts badges */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skillCount > 0 && (
              <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-accent-muted text-accent text-xs font-medium">
                <Lightning className="h-3 w-3" weight="fill" />
                {skillCount}
              </span>
            )}
            {commandCount > 0 && (
              <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-secondary-muted text-secondary text-xs font-medium">
                <Terminal className="h-3 w-3" weight="fill" />
                {commandCount}
              </span>
            )}
            {agentCount > 0 && (
              <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-done-muted text-done text-xs font-medium">
                <Robot className="h-3 w-3" weight="fill" />
                {agentCount}
              </span>
            )}
          </div>
        </div>

        {/* Selected indicator */}
        {isSelected && (
          <div className="shrink-0 h-5 w-5 rounded-full bg-accent flex items-center justify-center">
            <svg
              className="h-3 w-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

function LoadingState(): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 gap-3"
      data-testid="template-picker-loading"
    >
      <Spinner className="h-8 w-8 text-fg-muted animate-spin" />
      <p className="text-sm text-fg-muted">Loading templates...</p>
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 gap-3 text-center"
      data-testid="template-picker-empty"
    >
      <div className="h-16 w-16 rounded-full border-2 border-dashed border-border-muted bg-bg-subtle flex items-center justify-center">
        <Folder className="h-8 w-8 text-fg-subtle" weight="light" />
      </div>
      <div>
        <p className="text-sm font-medium text-fg-muted">No templates available</p>
        <p className="mt-1 text-xs text-fg-subtle">
          Add a template to your project or organization to get started
        </p>
      </div>
    </div>
  );
}

export function TemplatePicker({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  isLoading = false,
  className,
}: TemplatePickerProps): React.JSX.Element {
  // Group templates by scope in a single pass (hook must be before early returns)
  const { orgTemplates, projectTemplates } = useMemo(() => {
    const org: Template[] = [];
    const project: Template[] = [];
    for (const t of templates) {
      if (t.scope === 'org') org.push(t);
      else if (t.scope === 'project') project.push(t);
    }
    return { orgTemplates: org, projectTemplates: project };
  }, [templates]);

  if (isLoading) {
    return <LoadingState />;
  }

  if (templates.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className={cn('space-y-6', className)} data-testid="template-picker">
      {/* Organization templates */}
      {orgTemplates.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Folder className="h-4 w-4 text-secondary" weight="fill" />
            <h4 className="text-xs font-medium text-fg-muted uppercase tracking-wide">
              Organization Templates
            </h4>
            <span className="text-xs text-fg-subtle">({orgTemplates.length})</span>
          </div>
          <div className="space-y-2">
            {orgTemplates.map((template) => (
              <TemplateItem
                key={template.id}
                template={template}
                isSelected={selectedTemplateId === template.id}
                onSelect={() => onSelectTemplate(template)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Project templates */}
      {projectTemplates.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Code className="h-4 w-4 text-accent" weight="fill" />
            <h4 className="text-xs font-medium text-fg-muted uppercase tracking-wide">
              Project Templates
            </h4>
            <span className="text-xs text-fg-subtle">({projectTemplates.length})</span>
          </div>
          <div className="space-y-2">
            {projectTemplates.map((template) => (
              <TemplateItem
                key={template.id}
                template={template}
                isSelected={selectedTemplateId === template.id}
                onSelect={() => onSelectTemplate(template)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
