import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils/cn';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Search input for the project picker with magnifying glass icon,
 * clear button, and keyboard shortcut hint
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onChange, placeholder = 'Search codespaces...' }, ref) => {
    const isMac =
      typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
    const modKey = isMac ? 'Cmd' : 'Ctrl';

    return (
      <div className="px-5 py-3 border-b border-border-subtle">
        <div className="relative">
          <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
          <input
            ref={ref}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={cn(
              'w-full h-10 pl-10 pr-20',
              'bg-surface-inset border border-border rounded-md',
              'text-sm text-fg placeholder:text-fg-muted',
              'outline-none transition-all duration-150',
              'focus:border-accent focus:ring-2 focus:ring-accent/20'
            )}
            data-testid="project-search"
          />

          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {value && (
              <button
                type="button"
                onClick={() => onChange('')}
                className="p-1 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors mr-1"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <kbd className="px-1.5 py-0.5 bg-surface-hover border border-border rounded text-[11px] font-mono text-fg-muted">
              {modKey}
            </kbd>
            <kbd className="px-1.5 py-0.5 bg-surface-hover border border-border rounded text-[11px] font-mono text-fg-muted">
              P
            </kbd>
          </div>
        </div>
      </div>
    );
  }
);

SearchInput.displayName = 'SearchInput';
