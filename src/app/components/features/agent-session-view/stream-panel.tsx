import { Terminal } from '@phosphor-icons/react';
import { EmptyState } from '@/app/components/features/empty-state';
import { useAutoScroll } from '@/app/hooks/use-auto-scroll';
import type { ConnectionState } from '@/lib/streams/client';
import { cn } from '@/lib/utils/cn';
import { StreamCursor, StreamLine } from './stream-line';
import type { StreamLine as StreamLineData } from './use-stream-parser';

interface StreamPanelProps {
  lines: StreamLineData[];
  isStreaming: boolean;
  connectionState: ConnectionState;
  viewerColors?: string[];
}

export function StreamPanel({
  lines,
  isStreaming,
  connectionState,
  viewerColors = [],
}: StreamPanelProps): React.JSX.Element {
  const { containerRef, scrollToBottom, showScrollButton, handleScroll } = useAutoScroll();
  const connectionMeta =
    connectionState === 'connected'
      ? {
          label: isStreaming ? 'Live' : 'Connected',
          textClass: 'text-success',
          dotClass: isStreaming ? 'bg-success animate-pulse' : 'bg-success/80',
        }
      : connectionState === 'connecting'
        ? {
            label: 'Connecting',
            textClass: 'text-fg-muted',
            dotClass: 'bg-fg-muted animate-pulse',
          }
        : connectionState === 'reconnecting'
          ? {
              label: 'Reconnecting',
              textClass: 'text-attention',
              dotClass: 'bg-attention animate-pulse',
            }
          : {
              label: 'Disconnected',
              textClass: 'text-danger',
              dotClass: 'bg-danger',
            };
  const showStreamingCursor = isStreaming && connectionState === 'connected';

  return (
    <div className="flex flex-1 flex-col rounded-lg border border-border bg-surface m-4 mr-2 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-4 py-2">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Terminal className="h-4 w-4" weight="bold" />
          <span className="font-medium">Agent Stream</span>
          <span className="text-xs text-fg-muted" data-testid="token-usage">
            Tokens: --
          </span>
          <span className={cn('flex items-center gap-1.5 text-xs', connectionMeta.textClass)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', connectionMeta.dotClass)} />
            {connectionMeta.label}
          </span>
        </div>

        {/* Viewer indicators */}
        {viewerColors.length > 0 && (
          <div className="flex items-center gap-1">
            {viewerColors.slice(0, 3).map((color) => (
              <span key={color} className={cn('h-2 w-2 rounded-full', color)} />
            ))}
          </div>
        )}
      </div>

      {/* Stream content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-canvas p-4 font-mono text-sm"
        data-testid="session-output"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              preset="empty-session"
              size="sm"
              title="Waiting for output"
              subtitle="Agent messages will appear in real time."
            />
          </div>
        ) : (
          <div className="space-y-0">
            {lines.map((line) => (
              <div
                key={line.id}
                className="[content-visibility:auto] [contain-intrinsic-size:0_28px]"
              >
                <StreamLine line={line} showTimestamp />
              </div>
            ))}
            {showStreamingCursor && (
              <div className="flex items-center gap-2 py-0.5 pl-16">
                <StreamCursor />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Scroll to bottom indicator */}
      {showScrollButton && lines.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lg transition-opacity hover:bg-accent-hover"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
