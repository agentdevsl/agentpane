import type React from 'react';
import { cn } from '@/lib/utils/cn';

interface InsightSourceBadgeProps {
  source: string;
}

const SOURCE_CONFIG: Record<string, { label: string; className: string }> = {
  manual: { label: 'Manual', className: 'bg-accent-subtle text-accent' },
  agent_derived: { label: 'Agent', className: 'bg-success-subtle text-success' },
  dream: { label: 'Dream', className: 'bg-done-subtle text-done' },
};

export function InsightSourceBadge({ source }: InsightSourceBadgeProps): React.JSX.Element {
  const config = SOURCE_CONFIG[source] ?? {
    label: source,
    className: 'bg-surface-muted text-fg-muted',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        config.className
      )}
    >
      {config.label}
    </span>
  );
}
