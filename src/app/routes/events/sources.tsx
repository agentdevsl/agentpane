import { Plugs, Plus } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { AddSourceDialog } from '@/app/components/features/events/add-source-dialog';
import { EditSourceDialog } from '@/app/components/features/events/edit-source-dialog';
import { EventSourceCard } from '@/app/components/features/events/event-source-card';
import { Button } from '@/app/components/ui/button';
import { type EventStreamEvent, useEventStream } from '@/app/hooks/use-event-stream';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import type { CreateEventSourceInput, EventSource, EventSubscription } from '@/lib/events/types';

export const Route = createFileRoute('/events/sources')({
  component: EventSourcesPage,
});

function EventSourcesPage(): React.JSX.Element {
  const [sources, setSources] = useState<EventSource[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [editSource, setEditSource] = useState<EventSource | null>(null);
  const [subscriptions, setSubscriptions] = useState<EventSubscription[]>([]);

  const fetchSources = useCallback(async () => {
    const res = await apiClient.events.sources.list();
    if (res.ok) {
      setSources(res.data.items);
    }
  }, []);

  useMountEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sourcesRes, teamsRes, subsRes] = await Promise.all([
          apiClient.events.sources.list(),
          apiClient.teams.list(),
          apiClient.events.subscriptions.list(),
        ]);
        if (cancelled) return;
        if (sourcesRes.ok) setSources(sourcesRes.data.items);
        if (teamsRes.ok) setTeams(teamsRes.data.items);
        if (subsRes.ok) setSubscriptions(subsRes.data.items);
      } catch {
        // Network errors handled gracefully — empty state shown
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
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

  const handleSave = useCallback(
    async (name: string) => {
      if (!editSource) return;
      const res = await apiClient.events.sources.update(editSource.id, { name });
      if (!res.ok) {
        throw new Error(res.error.message ?? 'Failed to update source');
      }
      await fetchSources();
    },
    [editSource, fetchSources]
  );

  const handleToggle = useCallback(
    async (source: EventSource, enabled: boolean) => {
      try {
        const res = await apiClient.events.sources.update(source.id, { isEnabled: enabled });
        if (!res.ok) throw new Error(res.error.message ?? 'Failed to update source');
        await fetchSources();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to toggle source');
      }
    },
    [fetchSources]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (
        !window.confirm('Are you sure you want to delete this event source? This cannot be undone.')
      ) {
        return;
      }
      try {
        const res = await apiClient.events.sources.delete(id);
        if (!res.ok) throw new Error(res.error.message ?? 'Failed to delete source');
        await fetchSources();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to delete source');
      }
    },
    [fetchSources]
  );

  const handleRotateSecret = useCallback(async (id: string) => {
    if (
      !window.confirm(
        'Are you sure you want to rotate the webhook secret? The old secret will stop working immediately.'
      )
    ) {
      return;
    }
    try {
      const res = await apiClient.events.sources.rotateSecret(id);
      if (!res.ok) throw new Error(res.error.message ?? 'Failed to rotate secret');
      window.alert(
        `New webhook secret:\n\n${res.data.secret}\n\nSave this secret — it won't be shown again.`
      );
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to rotate secret');
    }
  }, []);

  // SSE: refresh source event counts when new events arrive (debounced)
  const sseDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEventStream({
    onEvent: useCallback(
      (event: EventStreamEvent) => {
        if (event.type === 'event:processed') {
          clearTimeout(sseDebounceRef.current);
          sseDebounceRef.current = setTimeout(() => fetchSources(), 500);
        }
      },
      [fetchSources]
    ),
  });

  // Clean up debounce timer on unmount
  useMountEffect(() => {
    return () => clearTimeout(sseDebounceRef.current);
  });

  if (isLoading) {
    return (
      <output className="flex flex-1 items-center justify-center" aria-label="Loading sources">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </output>
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
            <EventSourceCard
              key={source.id}
              source={source}
              subscriptionCount={subscriptions.filter((s) => s.eventSourceId === source.id).length}
              onEdit={() => setEditSource(source)}
              onToggle={(enabled) => handleToggle(source, enabled)}
              onDelete={() => handleDelete(source.id)}
              onRotateSecret={() => handleRotateSecret(source.id)}
            />
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

      {editSource && (
        <EditSourceDialog
          open={true}
          onClose={() => setEditSource(null)}
          source={editSource}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
