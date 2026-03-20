import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { QueueStatus } from '@/app/components/features/queue-status';
import { QueueWaitingState } from '@/app/components/features/queue-waiting-state';

// Queue position type for client-side display
type ClientQueuePosition = {
  taskId: string;
  position: number;
  estimatedWaitMinutes?: number;
};

export const Route = createFileRoute('/queue/')({
  component: QueuePage,
});

function QueuePage(): React.JSX.Element {
  const [queued, setQueued] = useState<ClientQueuePosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch queue from API on mount
  useEffect(() => {
    const fetchQueue = async () => {
      // TODO: [CQ-018] Add API endpoint for queue status
      // For now, just show empty state
      setQueued([]);
      setIsLoading(false);
    };
    fetchQueue();
  }, []);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Queue' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading queue...</div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell breadcrumbs={[{ label: 'Queue' }]}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        {queued.length === 0 ? (
          <EmptyState
            preset="no-results"
            title="Queue is empty"
            subtitle="All agent capacity is currently available."
          />
        ) : (
          <>
            <QueueWaitingState
              position={queued[0]?.position ?? 1}
              estimatedWaitMinutes={queued[0]?.estimatedWaitMinutes}
            />
            <QueueStatus
              queued={queued as Parameters<typeof QueueStatus>[0]['queued']}
              onOpenTask={() => {}}
            />
          </>
        )}
      </div>
    </LayoutShell>
  );
}
