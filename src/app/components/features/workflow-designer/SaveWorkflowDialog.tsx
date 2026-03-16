import { FloppyDisk, Spinner, WarningCircle, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { TextInput } from '@/app/components/ui/text-input';
import { Textarea } from '@/app/components/ui/textarea';
import type { Workflow, WorkflowStatus } from '@/db/schema';
import { cn } from '@/lib/utils/cn';

export interface SaveWorkflowDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** The workflow being saved (partial data for pre-filling form) */
  workflow: Partial<Workflow>;
  /** Callback when save is triggered */
  onSave: (data: {
    name: string;
    description?: string;
    status: WorkflowStatus;
    tags?: string[];
  }) => Promise<void>;
  /** Whether save operation is in progress */
  isSaving?: boolean;
  /** Error message to display */
  error?: string;
}

/**
 * TagInput component for managing workflow tags
 */
interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
}

function TagInput({ tags, onTagsChange, placeholder = 'Add a tag...' }: TagInputProps) {
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const trimmedValue = inputValue.trim();
      if (trimmedValue && !tags.includes(trimmedValue)) {
        onTagsChange([...tags, trimmedValue]);
      }
      setInputValue('');
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      onTagsChange(tags.slice(0, -1));
    }
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter((tag) => tag !== tagToRemove));
  };

  return (
    <div className="flex min-h-[36px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2 py-1.5 transition duration-fast ease-out focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-muted">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-accent-muted px-2 py-0.5 text-xs font-medium text-fg"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="rounded-full p-0.5 text-fg-muted transition hover:bg-surface-muted hover:text-fg"
            aria-label={`Remove tag: ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="min-w-[80px] flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        data-testid="tag-input"
      />
    </div>
  );
}

/**
 * WorkflowPreview component displays a placeholder thumbnail of the workflow
 */
interface WorkflowPreviewProps {
  workflow: Partial<Workflow>;
}

function WorkflowPreview({ workflow }: WorkflowPreviewProps) {
  const nodeCount = workflow.nodes?.length ?? 0;
  const edgeCount = workflow.edges?.length ?? 0;

  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface-subtle p-4"
      data-testid="workflow-preview"
    >
      {/* Placeholder thumbnail representation */}
      <div className="mb-3 flex h-20 w-full items-center justify-center rounded-md bg-surface-muted">
        <svg
          className="h-12 w-12 text-fg-subtle"
          viewBox="0 0 48 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {/* Simple workflow graph representation */}
          <circle cx="12" cy="24" r="4" fill="currentColor" />
          <circle cx="24" cy="12" r="4" fill="currentColor" />
          <circle cx="24" cy="36" r="4" fill="currentColor" />
          <circle cx="36" cy="24" r="4" fill="currentColor" />
          <path
            d="M16 24h4M28 12l4 8M28 36l4-8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-xs text-fg-muted">
          {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'} &middot; {edgeCount}{' '}
          {edgeCount === 1 ? 'edge' : 'edges'}
        </p>
      </div>
    </div>
  );
}

/**
 * SaveWorkflowDialog allows users to save workflows to the catalog.
 * Provides form fields for name, description, status, and tags.
 */
export function SaveWorkflowDialog({
  open,
  onOpenChange,
  workflow,
  onSave,
  isSaving = false,
  error,
}: SaveWorkflowDialogProps): React.JSX.Element {
  // Form state
  const [name, setName] = useState(workflow.name ?? '');
  const [description, setDescription] = useState(workflow.description ?? '');
  const [status, setStatus] = useState<WorkflowStatus>(workflow.status ?? 'draft');
  const [tags, setTags] = useState<string[]>(workflow.tags ?? []);

  // Validation state
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Validation helpers
  const nameError = touched.name && !name.trim() ? 'Name is required' : '';
  const canSubmit = name.trim() && !isSaving;

  // Reset form when dialog opens with new workflow data
  useEffect(() => {
    if (open) {
      setName(workflow.name ?? '');
      setDescription(workflow.description ?? '');
      setStatus(workflow.status ?? 'draft');
      setTags(workflow.tags ?? []);
      setTouched({});
    }
  }, [open, workflow]);

  // Handle field blur for validation
  const handleBlur = useCallback((field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }, []);

  // Handle form submission
  const handleSubmit = async (): Promise<void> => {
    // Mark all fields as touched for validation
    setTouched({ name: true });

    if (!canSubmit) return;

    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        tags: tags.length > 0 ? tags : undefined,
      });
    } catch {
      // Error is handled via the error prop
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="save-workflow-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FloppyDisk className="h-5 w-5 text-fg-muted" />
            Save Workflow
          </DialogTitle>
          <DialogDescription>
            Save this workflow to your catalog. You can publish it later or keep it as a draft.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="mt-4 space-y-4"
        >
          {/* Workflow Preview */}
          <WorkflowPreview workflow={workflow} />

          {/* Name field (required) */}
          <div className="space-y-2">
            <label
              htmlFor="workflow-name"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Name <span className="text-danger">*</span>
            </label>
            <TextInput
              id="workflow-name"
              value={name}
              placeholder="My Workflow"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => handleBlur('name')}
              disabled={isSaving}
              data-testid="workflow-name-input"
            />
            {nameError && (
              <p className="text-xs text-danger" data-testid="name-error">
                {nameError}
              </p>
            )}
          </div>

          {/* Description field (optional) */}
          <div className="space-y-2">
            <label
              htmlFor="workflow-description"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Description <span className="text-fg-subtle">(optional)</span>
            </label>
            <Textarea
              id="workflow-description"
              value={description}
              placeholder="A brief description of what this workflow does..."
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={isSaving}
              data-testid="workflow-description-input"
            />
          </div>

          {/* Status field */}
          <div className="space-y-2">
            <label
              htmlFor="workflow-status"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Status
            </label>
            <Select value={status} onValueChange={(value) => setStatus(value as WorkflowStatus)}>
              <SelectTrigger
                id="workflow-status"
                className={cn(isSaving && 'pointer-events-none opacity-60')}
                data-testid="workflow-status-trigger"
              >
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft" data-testid="workflow-status-draft">
                  Draft
                </SelectItem>
                <SelectItem value="published" data-testid="workflow-status-published">
                  Published
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-fg-subtle">
              {status === 'draft'
                ? 'Draft workflows are only visible to you.'
                : 'Published workflows are visible to all team members.'}
            </p>
          </div>

          {/* Tags field (optional, multi-input) */}
          <div className="space-y-2">
            <label
              htmlFor="workflow-tags"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Tags <span className="text-fg-subtle">(optional)</span>
            </label>
            <TagInput
              tags={tags}
              onTagsChange={setTags}
              placeholder="Add tags and press Enter..."
            />
            <p className="text-xs text-fg-subtle">
              Press Enter or comma to add a tag. Tags help organize and find workflows.
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div
              className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-muted p-3"
              data-testid="save-error"
            >
              <WarningCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" weight="fill" />
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}
        </form>

        <DialogFooter className="mt-6">
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            data-testid="cancel-button"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            data-testid="save-workflow-button"
          >
            {isSaving ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <FloppyDisk className="h-4 w-4" />
                Save Workflow
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
