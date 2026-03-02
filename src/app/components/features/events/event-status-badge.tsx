import { cn } from '@/lib/utils/cn';

const statusConfig: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success-muted text-success' },
  error: { label: 'Error', className: 'bg-danger-muted text-danger' },
  disabled: { label: 'Disabled', className: 'bg-surface-emphasis text-fg-muted' },
  received: { label: 'Received', className: 'bg-accent-muted text-accent' },
  matched: { label: 'Matched', className: 'bg-success-muted text-success' },
  task_created: { label: 'Task Created', className: 'bg-done-muted text-done' },
  ignored: { label: 'Ignored', className: 'bg-surface-emphasis text-fg-muted' },
};

const fallbackConfig = { className: 'bg-surface-emphasis text-fg-muted' };

export function EventStatusBadge({
  status,
  className: extraClassName,
}: {
  status: string;
  className?: string;
}): React.JSX.Element {
  const config = statusConfig[status];
  const label = config?.label ?? status;
  const badgeClassName = config?.className ?? fallbackConfig.className;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        badgeClassName,
        extraClassName
      )}
    >
      {label}
    </span>
  );
}
