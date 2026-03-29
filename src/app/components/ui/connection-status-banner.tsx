import { WifiHigh, WifiSlash } from '@phosphor-icons/react';
import type { ConnectionStatus } from '@/app/hooks/use-connection-health';

interface ConnectionStatusBannerProps {
  status: ConnectionStatus;
}

export function ConnectionStatusBanner({ status }: ConnectionStatusBannerProps) {
  if (status === 'connected') return null;

  return (
    <div
      role="alert"
      className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium ${
        status === 'reconnecting'
          ? 'bg-attention-subtle text-attention'
          : 'bg-danger-subtle text-danger'
      }`}
    >
      {status === 'reconnecting' ? (
        <>
          <WifiHigh size={14} className="animate-pulse" />
          <span>Reconnecting to real-time updates...</span>
        </>
      ) : (
        <>
          <WifiSlash size={14} />
          <span>Connection lost. Real-time updates paused.</span>
        </>
      )}
    </div>
  );
}
