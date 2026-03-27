import type { Icon } from '@phosphor-icons/react';
import {
  ArrowCounterClockwise,
  ArrowsIn,
  ArrowsOut,
  CaretDown,
  ChatText,
  Check,
  CircleNotch,
  FloppyDisk,
  Hexagon,
  Lightning,
  NotePencil,
  Robot,
  TreeStructure,
  Warning,
  WarningCircle,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { useTimeout } from '@/app/hooks/use-timeout';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import type { PromptCategory, PromptCategoryInfo, PromptDefinition } from '@/lib/prompts';
import {
  getPromptSettingsKeys,
  getPromptsByCategory,
  PROMPT_CATEGORIES,
  PROMPT_REGISTRY,
} from '@/lib/prompts';
import { cn } from '@/lib/utils/cn';

export const Route = createFileRoute('/settings/prompts')({
  loader: async () => {
    const keys = getPromptSettingsKeys();
    const result = await apiClient.settings.get(keys);
    if (result.ok) {
      const loaded: Record<string, string> = {};
      for (const prompt of Object.values(PROMPT_REGISTRY)) {
        const val = result.data.settings[prompt.settingsKey];
        if (typeof val === 'string' && val.length > 0) {
          loaded[prompt.id] = val;
        }
      }
      return { promptOverrides: loaded };
    }
    return { promptOverrides: null };
  },
  component: SystemPromptsPage,
});

// ============================================================================
// Category visual config
// ============================================================================

const CATEGORY_ICON: Record<PromptCategory, Icon> = {
  'agent-execution': Robot,
  'task-creation': Lightning,
  'terraform-compose': Hexagon,
  'workflow-designer': TreeStructure,
  'skill-improvement': Lightning,
};

const CATEGORY_COLOR: Record<PromptCategory, string> = {
  'agent-execution': 'claude',
  'task-creation': 'accent',
  'terraform-compose': 'success',
  'workflow-designer': 'attention',
  'skill-improvement': 'done',
};

const BADGE_CLASSES: Record<string, string> = {
  claude: 'bg-claude/10 text-claude',
  accent: 'bg-accent-muted text-accent',
  success: 'bg-success-muted text-success',
  attention: 'bg-attention-muted text-attention',
};

const ICON_BG_CLASSES: Record<string, string> = {
  claude: 'bg-gradient-to-br from-claude/15 to-claude/5 ring-1 ring-claude/15',
  accent: 'bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20',
  success: 'bg-gradient-to-br from-success-muted to-success-subtle ring-1 ring-success/15',
  attention: 'bg-gradient-to-br from-attention-muted to-attention-subtle ring-1 ring-attention/15',
};

const ICON_TEXT_CLASSES: Record<string, string> = {
  claude: 'text-claude',
  accent: 'text-accent',
  success: 'text-success',
  attention: 'text-attention',
};

// ============================================================================
// PromptEditor component
// ============================================================================

function PromptEditor({
  definition,
  value,
  onChange,
  color,
}: {
  definition: PromptDefinition;
  value: string;
  onChange: (value: string) => void;
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCustomized = value !== '' && value !== definition.defaultText;
  const displayText = value || definition.defaultText;
  const currentWordCount = displayText.split(/\s+/).filter((w) => w.length > 0).length;
  const lineCount = displayText.split('\n').length;

  const handleReset = useCallback(() => {
    onChange('');
  }, [onChange]);

  return (
    <div
      className={cn(
        'relative rounded-lg border transition-all',
        isCustomized
          ? 'border-accent/25 bg-surface-subtle/50'
          : 'border-border/70 bg-surface-subtle/30'
      )}
    >
      {/* Left accent bar */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg transition-opacity',
          isCustomized ? 'opacity-80' : 'opacity-40',
          color === 'claude' && 'bg-claude',
          color === 'accent' && 'bg-accent',
          color === 'success' && 'bg-success',
          color === 'attention' && 'bg-attention'
        )}
      />

      {/* Header */}
      <div className="flex items-start gap-3 px-5 pt-4">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-emphasis/50 mt-0.5">
          <ChatText className="h-4 w-4 text-fg-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-fg">{definition.name}</span>
            <span
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                isCustomized ? 'bg-accent-muted text-accent' : 'bg-surface-emphasis text-fg-subtle'
              )}
            >
              {isCustomized ? 'Customized' : 'Default'}
            </span>
            <span className="font-mono text-[11px] text-fg-subtle">~{currentWordCount} words</span>
          </div>
          <p className="mt-0.5 text-xs text-fg-muted leading-relaxed">{definition.description}</p>
        </div>
      </div>

      {/* Editor */}
      <div className="relative mx-5 mt-3">
        <textarea
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'w-full rounded-lg border border-border bg-surface-subtle px-4 py-3 font-mono text-xs leading-relaxed text-fg',
            'placeholder:text-fg-subtle transition-all resize-none',
            'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
            expanded ? 'min-h-[400px]' : 'max-h-[170px] overflow-hidden'
          )}
          spellCheck={false}
        />
        {!expanded && (
          <div className="pointer-events-none absolute bottom-0 left-[1px] right-[1px] h-12 rounded-b-[7px] bg-gradient-to-t from-surface-subtle to-transparent" />
        )}
        <span className="pointer-events-none absolute top-2 right-3 rounded bg-surface-emphasis px-2 py-0.5 font-mono text-[10px] text-fg-subtle">
          {lineCount} lines
        </span>
      </div>

      {/* Dynamic variable warning */}
      {definition.dynamicVariables.length > 0 && (
        <div className="mx-5 mt-2.5 flex items-center gap-2 rounded-md border border-attention/12 bg-attention/5 px-3 py-2 text-xs text-fg-muted">
          <WarningCircle className="h-3.5 w-3.5 flex-shrink-0 text-attention" />
          <span>
            Contains dynamic variable{definition.dynamicVariables.length > 1 ? 's' : ''}{' '}
            {definition.dynamicVariables.map((v, i) => (
              <span key={v}>
                {i > 0 && ', '}
                <code className="rounded bg-attention/10 px-1.5 py-0.5 font-mono text-[11px] text-attention">
                  {`{{${v}}}`}
                </code>
              </span>
            ))}{' '}
            &mdash; replaced at runtime
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-1 px-5 py-2.5">
        {isCustomized && (
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-emphasis hover:text-fg"
          >
            <ArrowCounterClockwise className="h-3.5 w-3.5" />
            Reset to Default
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
            expanded
              ? 'bg-accent-muted text-accent'
              : 'text-fg-muted hover:bg-surface-emphasis hover:text-fg'
          )}
        >
          {expanded ? (
            <>
              <ArrowsIn className="h-3.5 w-3.5" />
              Collapse
            </>
          ) : (
            <>
              <ArrowsOut className="h-3.5 w-3.5" />
              Expand
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// CategorySection component
// ============================================================================

function CategorySection({
  category,
  prompts,
  edits,
  onEdit,
  defaultOpen = true,
}: {
  category: PromptCategoryInfo;
  prompts: PromptDefinition[];
  edits: Record<string, string>;
  onEdit: (promptId: string, value: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const SectionIcon = CATEGORY_ICON[category.id];
  const color = CATEGORY_COLOR[category.id];

  return (
    <section className="rounded-xl border border-border bg-gradient-to-b from-surface to-surface-subtle/50 transition-colors hover:border-fg-subtle/30">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-4 px-6 py-5 text-left transition-colors hover:bg-surface-subtle/50"
      >
        <div
          className={cn(
            'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px]',
            ICON_BG_CLASSES[color]
          )}
        >
          <SectionIcon className={cn('h-5 w-5', ICON_TEXT_CLASSES[color])} weight="duotone" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">{category.label}</h2>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                BADGE_CLASSES[color]
              )}
            >
              {prompts.length} prompt{prompts.length !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-fg-muted">{category.description}</p>
        </div>
        <div
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-all',
            open ? 'bg-accent-muted' : 'bg-surface-emphasis'
          )}
        >
          <CaretDown
            className={cn(
              'h-4 w-4 transition-transform',
              open ? 'rotate-180 text-accent' : 'text-fg-muted'
            )}
          />
        </div>
      </button>

      {/* Section content */}
      <div
        className={cn(
          'grid transition-all duration-200',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-4 border-t border-border/50 px-6 py-5">
            {prompts.map((prompt) => (
              <PromptEditor
                key={prompt.id}
                definition={prompt}
                value={edits[prompt.id] ?? ''}
                onChange={(val) => onEdit(prompt.id, val)}
                color={color}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Main page
// ============================================================================

function SystemPromptsPage(): React.JSX.Element {
  const loaderData = Route.useLoaderData() as
    | { promptOverrides: Record<string, string> | null }
    | undefined;
  const [isLoading, setIsLoading] = useState(!loaderData?.promptOverrides);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stores current edit values — empty string means "use default"
  const [edits, setEdits] = useState<Record<string, string>>(
    () => (loaderData?.promptOverrides as Record<string, string>) ?? {}
  );
  // Stores the last-saved values to detect dirty state
  const [savedEdits, setSavedEdits] = useState<Record<string, string>>(
    () => (loaderData?.promptOverrides as Record<string, string>) ?? {}
  );

  const promptsByCategory = useMemo(() => getPromptsByCategory(), []);
  const allPrompts = useMemo(() => Object.values(PROMPT_REGISTRY), []);
  const settingsKeys = useMemo(() => getPromptSettingsKeys(), []);

  // Auto-dismiss saved indicator
  useTimeout(() => setSaved(false), saved ? 2000 : null);

  // Load saved overrides from settings
  useWatchEffect(() => {
    if (loaderData?.promptOverrides) return;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await apiClient.settings.get(settingsKeys);
        if (result.ok) {
          const loaded: Record<string, string> = {};
          for (const prompt of allPrompts) {
            const val = result.data.settings[prompt.settingsKey];
            if (typeof val === 'string' && val.length > 0) {
              loaded[prompt.id] = val;
            }
          }
          setEdits(loaded);
          setSavedEdits(loaded);
        } else {
          setError('Failed to load prompt settings. Using defaults.');
        }
      } catch {
        setError('Failed to load prompt settings. Using defaults.');
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [allPrompts, settingsKeys, loaderData]);

  const handleEdit = useCallback((promptId: string, value: string) => {
    const def = PROMPT_REGISTRY[promptId];
    if (!def) return;
    // If the user typed the exact default text, treat as "reset" (empty string)
    const storeValue = value === def.defaultText ? '' : value;
    setEdits((prev) => ({ ...prev, [promptId]: storeValue }));
  }, []);

  // Count dirty (unsaved) changes
  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const prompt of allPrompts) {
      const current = edits[prompt.id] ?? '';
      const saved = savedEdits[prompt.id] ?? '';
      if (current !== saved) count++;
    }
    return count;
  }, [edits, savedEdits, allPrompts]);

  const customizedCount = useMemo(
    () => allPrompts.filter((p) => (edits[p.id] ?? '').length > 0).length,
    [edits, allPrompts]
  );

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const settingsToUpdate: Record<string, unknown> = {};
      for (const prompt of allPrompts) {
        const current = edits[prompt.id] ?? '';
        const prev = savedEdits[prompt.id] ?? '';
        if (current !== prev) {
          settingsToUpdate[prompt.settingsKey] = current;
        }
      }
      if (Object.keys(settingsToUpdate).length === 0) return;

      const result = await apiClient.settings.update(settingsToUpdate);
      if (result.ok) {
        setSavedEdits({ ...edits });
        setSaved(true);
      } else {
        setError('Failed to save settings. Please try again.');
      }
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [allPrompts, edits, savedEdits]);

  return (
    <div data-testid="system-prompts-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header */}
      <header className="relative mb-10">
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-claude/10 ring-1 ring-accent/20">
              <ChatText className="h-6 w-6 text-accent" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">System Prompts</h1>
              <p className="text-sm text-fg-muted">Customize AI behavior for each feature</p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <ChatText className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{allPrompts.length}</span> prompts
              </span>
            </div>
            <div className="h-4 w-px self-center bg-border" />
            <div className="flex items-center gap-2">
              <NotePencil className="h-4 w-4 text-accent" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{customizedCount}</span> customized
              </span>
            </div>
            <div className="h-4 w-px self-center bg-border" />
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{allPrompts.length - customizedCount}</span>{' '}
                defaults
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <CircleNotch className="h-6 w-6 animate-spin text-fg-muted" />
        </div>
      )}

      {/* Category sections */}
      {!isLoading && (
        <div className="space-y-5">
          {PROMPT_CATEGORIES.map((category, idx) => {
            const prompts = promptsByCategory.get(category.id) ?? [];
            if (prompts.length === 0) return null;
            return (
              <CategorySection
                key={category.id}
                category={category}
                prompts={prompts}
                edits={edits}
                onEdit={handleEdit}
                defaultOpen={idx < 3}
              />
            );
          })}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
              <Warning className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Sticky save footer */}
          <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-border bg-surface/95 px-5 py-4 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-2">
              {dirtyCount > 0 && <WarningCircle className="h-4 w-4 text-attention" />}
              <p className="text-sm text-fg-muted">
                {dirtyCount > 0 ? (
                  <>
                    Unsaved changes (
                    <span className="font-semibold text-attention">{dirtyCount}</span>)
                  </>
                ) : (
                  'All prompts saved'
                )}
              </p>
            </div>
            <Button
              data-testid="save-prompt-settings"
              onClick={handleSave}
              disabled={isLoading || isSaving || dirtyCount === 0}
              className={cn(
                'min-w-[140px] transition-all',
                saved && 'bg-success-emphasis hover:bg-success-emphasis'
              )}
            >
              {isSaving ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : saved ? (
                <>
                  <Check className="h-4 w-4" weight="bold" />
                  Saved!
                </>
              ) : (
                <>
                  <FloppyDisk className="h-4 w-4" />
                  Save All
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
