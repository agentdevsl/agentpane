import {
  DotsThree,
  Lightning,
  PencilSimple,
  ToggleLeft,
  ToggleRight,
  Trash,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu';
import type { EventSubscription } from '@/lib/events/types';

interface SubscriptionCardProps {
  subscription: EventSubscription;
  sourceName?: string;
  codespaceName?: string;
  onEdit?: () => void;
  onToggle?: (enabled: boolean) => void;
  onDelete?: () => void;
}

export function SubscriptionCard({
  subscription,
  sourceName,
  codespaceName,
  onEdit,
  onToggle,
  onDelete,
}: SubscriptionCardProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface p-4 transition-colors hover:border-fg-subtle">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Lightning className="h-4 w-4 flex-shrink-0 text-accent" />
          <span className="truncate text-sm font-medium text-fg">{subscription.name}</span>
          {!subscription.isEnabled && (
            <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-xs text-fg-subtle">
              Disabled
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          {sourceName && <span>Source: {sourceName}</span>}
          {codespaceName && <span>&rarr; {codespaceName}</span>}
          <span>{subscription.matchedCount} matched</span>
        </div>
        {subscription.eventTypes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {subscription.eventTypes.map((et) => (
              <span key={et} className="rounded bg-accent-muted px-1.5 py-0.5 text-xs text-accent">
                {et}
              </span>
            ))}
          </div>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
          >
            <DotsThree className="h-4 w-4" weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <PencilSimple className="mr-2 h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onToggle?.(!subscription.isEnabled)}>
            {subscription.isEnabled ? (
              <ToggleLeft className="mr-2 h-3.5 w-3.5" />
            ) : (
              <ToggleRight className="mr-2 h-3.5 w-3.5" />
            )}
            {subscription.isEnabled ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="text-danger">
            <Trash className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
