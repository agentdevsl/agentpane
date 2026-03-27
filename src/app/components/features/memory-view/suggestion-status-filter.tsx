import type React from 'react';
import { cn } from '@/lib/utils/cn';

interface SuggestionStatusFilterProps {
  value: string;
  onChange: (value: string) => void;
  counts: { all: number; pending: number; accepted: number; rejected: number; modified: number };
}

const FILTER_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'modified', label: 'Modified' },
] as const;

export function SuggestionStatusFilter({
  value,
  onChange,
  counts,
}: SuggestionStatusFilterProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {FILTER_OPTIONS.map(({ key, label }) => {
        const isActive = value === key;
        const count = counts[key];

        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-subtle'
            )}
          >
            {label}
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                isActive ? 'bg-white/20 text-white' : 'bg-surface-subtle text-fg-subtle'
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
