/**
 * StreamReconnectBanner — F05-15.
 *
 * Rendered when the durable streams client fires `onTerminalDisconnect`,
 * meaning the MAX_RECONNECT_ATTEMPTS budget has been exhausted and no more
 * automatic retries will happen. The user needs to click "Reconnect" for
 * the session to resume.
 */

import { ArrowClockwise, WifiSlash } from '@phosphor-icons/react';

export interface StreamReconnectBannerProps {
  /** Called when the user clicks the reconnect button. */
  onReconnect: () => void;
  /** Disable the button while the reconnect is in flight. */
  loading?: boolean;
}

export function StreamReconnectBanner({
  onReconnect,
  loading = false,
}: StreamReconnectBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-danger-subtle bg-danger-subtle px-3 py-1.5 text-xs font-medium text-danger"
    >
      <WifiSlash size={14} aria-hidden="true" />
      <span>Disconnected from live updates. Click reconnect to resume.</span>
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-1 rounded border border-danger-muted px-2 py-0.5 hover:bg-danger-muted/30 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={onReconnect}
        disabled={loading}
      >
        <ArrowClockwise size={12} className={loading ? 'animate-spin' : undefined} />
        {loading ? 'Reconnecting…' : 'Reconnect'}
      </button>
    </div>
  );
}
