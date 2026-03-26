import { SlidersHorizontal } from '@phosphor-icons/react';
import { Checkbox } from '@/app/components/ui/checkbox';
import { ALL_TOOLS, TOOL_GROUPS } from '@/lib/constants/tools';
import { cn } from '@/lib/utils/cn';

export interface ToolAccessSelectorProps {
  /** Currently selected tools (empty array = allow all) */
  value: string[];
  /** Called when tool selection changes */
  onChange: (tools: string[]) => void;
  /** Additional CSS classes */
  className?: string;
  /** Compact single-row display */
  compact?: boolean;
  /** Test ID */
  'data-testid'?: string;
}

/**
 * Tool access selector with grouped checkboxes.
 * Allows selecting which tools an agent can use.
 */
export function ToolAccessSelector({
  value,
  onChange,
  className,
  compact = false,
  'data-testid': testId = 'tool-access-selector',
}: ToolAccessSelectorProps): React.JSX.Element {
  const toggleTool = (tool: string): void => {
    const next = value.includes(tool) ? value.filter((t) => t !== tool) : [...value, tool];
    onChange(next);
  };

  const toggleGroup = (tools: readonly string[]): void => {
    const allSelected = tools.every((t) => value.includes(t));
    if (allSelected) {
      onChange(value.filter((t) => !tools.includes(t)));
    } else {
      const newTools = new Set([...value, ...tools]);
      onChange([...newTools]);
    }
  };

  // Empty array means "allow all" in the whitelist hook
  const isAllowAll = value.length === 0;

  const setAllowAll = (enabled: boolean): void => {
    if (enabled) {
      onChange([]); // Empty = allow all
    } else {
      onChange([...ALL_TOOLS]); // Start with all selected
    }
  };

  const selectAllExplicit = (): void => {
    onChange([...ALL_TOOLS]);
  };

  const selectNone = (): void => {
    onChange([]);
  };

  if (compact) {
    return (
      <div className={cn('flex flex-wrap gap-2', className)} data-testid={testId}>
        {Object.values(TOOL_GROUPS)
          .flat()
          .map((tool) => (
            <label
              key={tool}
              htmlFor={`compact-tool-${tool}`}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                value.includes(tool)
                  ? 'border-accent bg-accent-muted text-accent'
                  : 'border-border bg-surface-subtle text-fg-muted hover:border-fg-subtle'
              )}
            >
              <Checkbox
                id={`compact-tool-${tool}`}
                checked={value.includes(tool)}
                onCheckedChange={() => toggleTool(tool)}
                className="h-3 w-3"
              />
              {tool}
            </label>
          ))}
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)} data-testid={testId}>
      {/* Allow All toggle */}
      <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle p-3">
        <div>
          <span className="text-sm font-medium text-fg">Allow All Tools</span>
          <p className="text-xs text-fg-muted">Grant access to all current and future tools</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isAllowAll}
          onClick={() => setAllowAll(!isAllowAll)}
          className={cn(
            'relative h-6 w-11 rounded-full transition-colors',
            isAllowAll ? 'bg-accent' : 'bg-surface-emphasis'
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
              isAllowAll ? 'translate-x-5' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Tool selection (disabled when Allow All is on) */}
      <div className={cn(isAllowAll && 'pointer-events-none opacity-50')}>
        {/* Quick actions */}
        <div className="mb-4 flex gap-2 text-xs">
          <button
            type="button"
            onClick={selectAllExplicit}
            className="text-accent hover:underline"
            disabled={isAllowAll}
          >
            Select all
          </button>
          <span className="text-fg-subtle">|</span>
          <button
            type="button"
            onClick={selectNone}
            className="text-accent hover:underline"
            disabled={isAllowAll}
          >
            Clear all
          </button>
        </div>

        {/* Tool groups */}
        {Object.entries(TOOL_GROUPS).map(([group, tools]) => {
          const groupSelected = tools.filter((t) => value.includes(t)).length;
          const allGroupSelected = groupSelected === tools.length;

          return (
            <div key={group} className="mb-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {group}
                </div>
                <button
                  type="button"
                  onClick={() => toggleGroup(tools)}
                  className="text-xs text-accent hover:underline"
                  disabled={isAllowAll}
                >
                  {allGroupSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {tools.map((tool) => (
                  <label
                    key={tool}
                    htmlFor={`tool-${tool}`}
                    className="flex cursor-pointer items-center gap-2 text-sm text-fg min-w-0"
                  >
                    <Checkbox
                      id={`tool-${tool}`}
                      checked={isAllowAll || value.includes(tool)}
                      onCheckedChange={() => toggleTool(tool)}
                      disabled={isAllowAll}
                      className="flex-shrink-0"
                    />
                    <span className="truncate" title={tool}>
                      {tool}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="text-xs text-fg-muted">
        {isAllowAll ? 'All tools allowed' : `${value.length} of ${ALL_TOOLS.length} tools selected`}
      </div>
    </div>
  );
}
