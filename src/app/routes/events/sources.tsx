import { Plugs, Plus } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { AddSourceDialog } from '@/app/components/features/events/add-source-dialog';
import { EventSourceCard } from '@/app/components/features/events/event-source-card';
import { Button } from '@/app/components/ui/button';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import type { CreateEventSourceInput, EventSource } from '@/lib/events/types';

export const Route = createFileRoute('/events/sources')({
  component: EventSourcesPage,
});

function EventSourcesPage(): React.JSX.Element {
  const [sources, setSources] = useState<EventSource[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const fetchSources = useCallback(async () => {
    const res = await apiClient.events.sources.list();
    if (res.ok) {
      setSources(res.data.items);
    }
  }, []);

  useMountEffect(() => {
    async function load() {
      const [sourcesRes, teamsRes] = await Promise.all([
        apiClient.events.sources.list(),
        apiClient.teams.list(),
      ]);
      if (sourcesRes.ok) setSources(sourcesRes.data.items);
      if (teamsRes.ok) setTeams(teamsRes.data.items);
      setIsLoading(false);
    }
    load();
  });

  const handleAdd = useCallback(
    async (data: CreateEventSourceInput) => {
      setIsAdding(true);
      try {
        const res = await apiClient.events.sources.create(data);
        if (!res.ok) {
          throw new Error(res.error.message ?? 'Failed to create source');
        }
        await fetchSources();
        return {
          webhookSecret: res.data.webhookSecret,
          webhookUrl: res.data.webhookUrl,
        };
      } finally {
        setIsAdding(false);
      }
    },
    [fetchSources]
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Event Sources</h2>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Add Source
        </Button>
      </div>

      {sources.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={Plugs}
            title="No Event Sources"
            subtitle="Connect GitHub, Linear, or other sources to start receiving events"
            primaryAction={{
              label: 'Add Source',
              onClick: () => setShowAddDialog(true),
              icon: <Plus className="h-4 w-4" />,
            }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((source) => (
            <EventSourceCard key={source.id} source={source} />
          ))}
        </div>
      )}

      <AddSourceDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAdd}
        isAdding={isAdding}
        teams={teams}
      />
    </div>
  );
}
