import {
  ArrowsClockwise,
  DotsThree,
  Eye,
  EyeSlash,
  Lightning,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu';
import type { EventSource } from '@/lib/events/types';
import { EventSourceIcon } from './event-source-icon';
import { EventStatusBadge } from './event-status-badge';

interface EventSourceCardProps {
  source: EventSource;
  subscriptionCount?: number;
  onEdit?: () => void;
  onToggle?: (enabled: boolean) => void;
  onDelete?: () => void;
  onRotateSecret?: () => void;
}

export function EventSourceCard({
  source,
  subscriptionCount,
  onEdit,
  onToggle,
  onDelete,
  onRotateSecret,
}: EventSourceCardProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-fg-subtle">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-subtle">
            <EventSourceIcon type={source.type} className="h-4 w-4 text-fg-muted" />
          </div>
          <div>
            <div className="text-sm font-medium text-fg">{source.name}</div>
            <div className="text-xs text-fg-muted">{source.type}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <EventStatusBadge status={source.status} />
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
              <DropdownMenuItem onClick={() => onToggle?.(!source.isEnabled)}>
                {source.isEnabled ? (
                  <EyeSlash className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <Eye className="mr-2 h-3.5 w-3.5" />
                )}
                {source.isEnabled ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRotateSecret}>
                <ArrowsClockwise className="mr-2 h-3.5 w-3.5" />
                Rotate Secret
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-danger">
                <Trash className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span>{source.eventCount} events</span>
        {typeof subscriptionCount === 'number' && (
          <Link
            to="/events/subscriptions"
            search={{ sourceId: source.id }}
            className="flex items-center gap-1 text-accent hover:text-accent/80"
          >
            <Lightning className="h-3 w-3" />
            {subscriptionCount} {subscriptionCount === 1 ? 'subscription' : 'subscriptions'}
          </Link>
        )}
        {source.lastEventAt && (
          <span>Last: {new Date(source.lastEventAt).toLocaleDateString()}</span>
        )}
      </div>

      <div className="rounded bg-surface-subtle px-2 py-1 font-mono text-xs text-fg-subtle">
        /hooks/events/{source.slug}
      </div>
    </div>
  );
}
