import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { Robot, Sparkle, UserCircle } from '@phosphor-icons/react';
import type React from 'react';
import { cn } from '@/lib/utils/cn';

interface InsightSourceBadgeProps {
  source: string;
}

const SOURCE_CONFIG: Record<string, { label: string; className: string; icon: PhosphorIcon }> = {
  manual: { label: 'Manual', className: 'bg-accent-subtle text-accent', icon: UserCircle },
  agent_derived: { label: 'Agent', className: 'bg-success-subtle text-success', icon: Robot },
  dream: { label: 'Dream', className: 'bg-done-subtle text-done', icon: Sparkle },
};

export function InsightSourceBadge({ source }: InsightSourceBadgeProps): React.JSX.Element {
  const config = SOURCE_CONFIG[source] ?? {
    label: source,
    className: 'bg-surface-muted text-fg-muted',
    icon: null as PhosphorIcon | null,
  };

  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        config.className
      )}
    >
      {Icon && <Icon size={10} />}
      {config.label}
    </span>
  );
}
