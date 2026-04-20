/**
 * TruncationBanner — F05-04.
 *
 * Rendered when `useSession`'s state.truncated flag is true. Tells the user
 * that earlier session chunks were dropped from memory, and lets them fetch
 * them via GET /api/sessions/:id/events?beforeOffset=N.
 */

import { ClockCounterClockwise } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export interface TruncationBannerProps {
  /** Total number of chunks dropped from the head of the buffer. */
  truncatedCount: number;
  /** Disable the "load earlier" button while a fetch is in flight. */
  loading?: boolean;
  /** User clicked "load earlier" — consumer should call the REST endpoint. */
  onLoadEarlier?: () => void;
  /** Optional trailing content (e.g. a link to full session export). */
  trailing?: ReactNode;
}

export function TruncationBanner({
  truncatedCount,
  loading = false,
  onLoadEarlier,
  trailing,
}: TruncationBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-attention-subtle bg-attention-subtle px-3 py-1.5 text-xs font-medium text-attention"
    >
      <ClockCounterClockwise size={14} aria-hidden="true" />
      <span>
        {truncatedCount.toLocaleString()} earlier{' '}
        {truncatedCount === 1 ? 'event was' : 'events were'} trimmed from the live view.
      </span>
      {onLoadEarlier ? (
        <button
          type="button"
          className="ml-auto rounded border border-attention-muted px-2 py-0.5 hover:bg-attention-muted/30 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onLoadEarlier}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Load earlier'}
        </button>
      ) : null}
      {trailing}
    </div>
  );
}
