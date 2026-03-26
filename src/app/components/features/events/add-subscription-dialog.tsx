import { Plus, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import type {
  CreateSubscriptionInput,
  EventSource,
  EventSubscription,
  SubscriptionFilter,
  UpdateSubscriptionInput,
} from '@/lib/events/types';

// Hardcoded event types per source type
const EVENT_TYPES_BY_SOURCE: Record<string, Array<{ type: string; label: string }>> = {
  github: [
    { type: 'issues', label: 'Issues' },
    { type: 'pull_request', label: 'Pull Requests' },
    { type: 'push', label: 'Push' },
    { type: 'ping', label: 'Ping' },
  ],
  linear: [
    { type: 'Issue', label: 'Issues' },
    { type: 'Comment', label: 'Comments' },
    { type: 'Project', label: 'Projects' },
  ],
  jira: [
    { type: 'jira:issue_created', label: 'Issue Created' },
    { type: 'jira:issue_updated', label: 'Issue Updated' },
  ],
  generic_webhook: [],
  cron: [{ type: 'tick', label: 'Tick' }],
};

// Template variable hints per source type
const TEMPLATE_VARS: Record<string, string> = {
  github:
    '{{event.type}}, {{event.action}}, {{repo.name}}, {{repo.full_name}}, {{author.login}}, {{issue.title}}, {{issue.body}}, {{issue.number}}, {{pr.title}}, {{pr.body}}, {{pr.number}}, {{pr.branch}}',
  linear: '{{event.type}}, {{event.action}}, {{author.login}}',
  jira: '{{event.type}}, {{event.action}}, {{author.login}}',
  generic_webhook: '{{event.type}}, {{event.action}}',
  cron: '{{schedule.name}}, {{schedule.cronExpression}}, {{schedule.executionCount}}',
};

const FILTER_FIELDS = ['repo', 'branch', 'labels', 'author', 'action'] as const;
const FILTER_OPERATORS = ['equals', 'contains', 'matches', 'not_equals'] as const;

// Task column options
const TASK_COLUMNS = ['backlog', 'queued', 'in_progress'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

interface AddSubscriptionDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: CreateSubscriptionInput | UpdateSubscriptionInput, id?: string) => Promise<void>;
  sources: EventSource[];
  codespaces: Array<{ id: string; name: string }>;
  editSubscription?: EventSubscription | null;
}

export function AddSubscriptionDialog({
  open,
  onClose,
  onSave,
  sources,
  codespaces,
  editSubscription,
}: AddSubscriptionDialogProps): React.JSX.Element {
  const isEditing = !!editSubscription;

  const [name, setName] = useState(editSubscription?.name ?? '');
  const [eventSourceId, setEventSourceId] = useState(editSubscription?.eventSourceId ?? '');
  const [targetCodespaceId, setTargetCodespaceId] = useState(
    editSubscription?.targetCodespaceId ?? ''
  );
  const [eventTypes, setEventTypes] = useState<string[]>(editSubscription?.eventTypes ?? []);
  const [filters, setFilters] = useState<SubscriptionFilter[]>(editSubscription?.filters ?? []);
  const [promptTemplate, setPromptTemplate] = useState(editSubscription?.promptTemplate ?? '');
  const [autoStartAgent, setAutoStartAgent] = useState(editSubscription?.autoStartAgent ?? false);
  const [taskColumn, setTaskColumn] = useState(editSubscription?.taskColumn ?? 'backlog');
  const [taskPriority, setTaskPriority] = useState(editSubscription?.taskPriority ?? 'medium');
  const [taskLabels, setTaskLabels] = useState(editSubscription?.taskLabels?.join(', ') ?? '');

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSource = sources.find((s) => s.id === eventSourceId);
  const availableEventTypes = selectedSource
    ? (EVENT_TYPES_BY_SOURCE[selectedSource.type] ?? [])
    : [];
  const templateVarHint = selectedSource ? (TEMPLATE_VARS[selectedSource.type] ?? '') : '';

  const handleToggleEventType = (et: string) => {
    setEventTypes((prev) => (prev.includes(et) ? prev.filter((t) => t !== et) : [...prev, et]));
  };

  const handleAddFilter = () => {
    setFilters((prev) => [...prev, { field: 'repo', operator: 'equals', value: '' }]);
  };

  const handleRemoveFilter = (index: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFilterChange = (index: number, key: keyof SubscriptionFilter, value: string) => {
    setFilters((prev) => prev.map((f, i) => (i === index ? { ...f, [key]: value } : f)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!eventSourceId) {
      setError('Event source is required');
      return;
    }
    if (!targetCodespaceId) {
      setError('Target codespace is required');
      return;
    }
    if (!promptTemplate.trim()) {
      setError('Prompt template is required');
      return;
    }

    const labels = taskLabels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);

    setIsSaving(true);
    try {
      if (isEditing) {
        await onSave(
          {
            name: name.trim(),
            eventTypes,
            filters: filters.filter((f) => f.value.trim()),
            promptTemplate: promptTemplate.trim(),
            autoStartAgent,
            taskColumn,
            taskPriority,
            taskLabels: labels,
          },
          editSubscription?.id
        );
      } else {
        await onSave({
          name: name.trim(),
          eventSourceId,
          targetCodespaceId,
          eventTypes,
          filters: filters.filter((f) => f.value.trim()),
          promptTemplate: promptTemplate.trim(),
          autoStartAgent,
          taskColumn,
          taskPriority,
          taskLabels: labels,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Subscription' : 'Add Subscription'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Section 1: Basics */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Basics
            </h4>
            <div>
              <label htmlFor="sub-name" className="mb-1 block text-xs font-medium text-fg-muted">
                Name
              </label>
              <input
                id="sub-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Bug reports → Agent"
                disabled={isSaving}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label htmlFor="sub-source" className="mb-1 block text-xs font-medium text-fg-muted">
                Event Source
              </label>
              <select
                id="sub-source"
                value={eventSourceId}
                onChange={(e) => {
                  setEventSourceId(e.target.value);
                  setEventTypes([]);
                }}
                disabled={isSaving || isEditing}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Select a source</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.type})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="sub-codespace"
                className="mb-1 block text-xs font-medium text-fg-muted"
              >
                Target Codespace
              </label>
              <select
                id="sub-codespace"
                value={targetCodespaceId}
                onChange={(e) => setTargetCodespaceId(e.target.value)}
                disabled={isSaving || isEditing}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Select a codespace</option>
                {codespaces.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Section 2: Event Filtering */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Event Filtering
            </h4>
            {availableEventTypes.length > 0 && (
              <div>
                <span className="mb-1.5 block text-xs font-medium text-fg-muted">Event Types</span>
                <div className="flex flex-wrap gap-2">
                  {availableEventTypes.map((et) => (
                    <label key={et.type} className="flex items-center gap-1.5 text-xs text-fg">
                      <input
                        type="checkbox"
                        checked={eventTypes.includes(et.type)}
                        onChange={() => handleToggleEventType(et.type)}
                        className="rounded border-border"
                        disabled={isSaving}
                      />
                      {et.label}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-fg-subtle">
                  Leave all unchecked to match all event types
                </p>
              </div>
            )}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-fg-muted">Filters</span>
                <button
                  type="button"
                  onClick={handleAddFilter}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
                >
                  <Plus className="h-3 w-3" /> Add Filter
                </button>
              </div>
              {filters.length === 0 && (
                <p className="text-xs text-fg-subtle">
                  No filters — all events from this source will match
                </p>
              )}
              {filters.map((filter, i) => (
                <div key={`filter-${i}`} className="mb-2 flex items-center gap-2">
                  <select
                    value={filter.field}
                    onChange={(e) => handleFilterChange(i, 'field', e.target.value)}
                    disabled={isSaving}
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {FILTER_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filter.operator}
                    onChange={(e) => handleFilterChange(i, 'operator', e.target.value)}
                    disabled={isSaving}
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {FILTER_OPERATORS.map((o) => (
                      <option key={o} value={o}>
                        {o.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={filter.value}
                    onChange={(e) => handleFilterChange(i, 'value', e.target.value)}
                    placeholder="Value"
                    disabled={isSaving}
                    className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveFilter(i)}
                    disabled={isSaving}
                    className="rounded p-1 text-fg-muted hover:bg-surface-subtle hover:text-danger"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Task Creation */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Task Creation
            </h4>
            <div>
              <label htmlFor="sub-prompt" className="mb-1 block text-xs font-medium text-fg-muted">
                Prompt Template
              </label>
              <textarea
                id="sub-prompt"
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                rows={4}
                disabled={isSaving}
                placeholder="Describe what the agent should do when this event occurs..."
                className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
              {templateVarHint && (
                <p className="mt-1 text-xs text-fg-subtle">
                  Available variables: {templateVarHint}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-fg">Auto-start Agent</span>
                <p className="text-xs text-fg-subtle">
                  Automatically start an agent when a task is created
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAutoStartAgent(!autoStartAgent)}
                disabled={isSaving}
                className={`relative h-5 w-9 rounded-full transition-colors ${autoStartAgent ? 'bg-accent' : 'bg-border'}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${autoStartAgent ? 'left-[18px]' : 'left-0.5'}`}
                />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="sub-column"
                  className="mb-1 block text-xs font-medium text-fg-muted"
                >
                  Task Column
                </label>
                <select
                  id="sub-column"
                  value={taskColumn}
                  onChange={(e) => setTaskColumn(e.target.value)}
                  disabled={isSaving}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {TASK_COLUMNS.map((c) => (
                    <option key={c} value={c}>
                      {c.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="sub-priority"
                  className="mb-1 block text-xs font-medium text-fg-muted"
                >
                  Priority
                </label>
                <select
                  id="sub-priority"
                  value={taskPriority}
                  onChange={(e) => setTaskPriority(e.target.value)}
                  disabled={isSaving}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="sub-labels" className="mb-1 block text-xs font-medium text-fg-muted">
                Labels (comma-separated)
              </label>
              <input
                id="sub-labels"
                type="text"
                value={taskLabels}
                onChange={(e) => setTaskLabels(e.target.value)}
                placeholder="bug, automated"
                disabled={isSaving}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          {error && (
            <div className="rounded bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Subscription'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
