import { CaretDown, CaretRight, Gear } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';
import { Skeleton, SkeletonText } from '@/app/components/ui/skeleton';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import type { StreamViewerProps } from '../types';
import { StreamEntry } from './stream-entry';

export function StreamViewer({
  entries,
  currentEntryId,
  isLoading = false,
}: StreamViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentEntryRef = useRef<HTMLDivElement>(null);
  const [startupExpanded, setStartupExpanded] = useState(false);

  // Separate startup entries from main entries
  const { startupEntries, mainEntries } = useMemo(() => {
    const startup: typeof entries = [];
    const main: typeof entries = [];
    for (const entry of entries) {
      if (entry.isStartup) {
        startup.push(entry);
      } else {
        main.push(entry);
      }
    }
    return { startupEntries: startup, mainEntries: main };
  }, [entries]);

  // Scroll to current entry when it changes
  useWatchEffect(() => {
    if (currentEntryId && currentEntryRef.current) {
      currentEntryRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentEntryId]);

  if (isLoading) {
    return (
      <div
        className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 md:p-4"
        data-testid="stream-viewer-loading"
      >
        {['skeleton-0', 'skeleton-1', 'skeleton-2'].map((id) => (
          <div key={id} className="flex gap-2.5 rounded bg-surface-subtle p-2">
            <Skeleton variant="text" width={40} height={14} />
            <div className="flex-1 space-y-1">
              <Skeleton variant="text" width={70} height={12} />
              <SkeletonText lines={1} lineHeight={14} lastLineWidth={90} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 md:p-6"
        data-testid="stream-viewer-empty"
      >
        <p className="text-sm text-fg-muted">No events to display</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 md:p-4"
      data-testid="stream-viewer"
      role="log"
      aria-label="Session event stream"
    >
      {/* Startup logs section - collapsible */}
      {startupEntries.length > 0 ? (
        <div className="mb-3 rounded-md border border-border bg-surface-subtle">
          <button
            type="button"
            onClick={() => setStartupExpanded(!startupExpanded)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-fg-muted hover:bg-surface-muted transition-colors"
          >
            {startupExpanded ? (
              <CaretDown className="h-3.5 w-3.5" />
            ) : (
              <CaretRight className="h-3.5 w-3.5" />
            )}
            <Gear className="h-3.5 w-3.5" />
            <span>System Logs</span>
            <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-[10px] text-fg-subtle">
              {startupEntries.length}
            </span>
          </button>
          {startupExpanded ? (
            <div className={cn('border-t border-border p-2 space-y-1')}>
              {startupEntries.map((entry) => {
                const isCurrent = entry.id === currentEntryId;
                return (
                  <div key={entry.id} ref={isCurrent ? currentEntryRef : undefined}>
                    <StreamEntry entry={entry} isCurrent={isCurrent} />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Main entries */}
      {mainEntries.map((entry) => {
        const isCurrent = entry.id === currentEntryId;
        return (
          <div key={entry.id} ref={isCurrent ? currentEntryRef : undefined}>
            <StreamEntry entry={entry} isCurrent={isCurrent} />
          </div>
        );
      })}
    </div>
  );
}
