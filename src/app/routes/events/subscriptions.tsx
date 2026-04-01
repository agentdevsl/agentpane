import { Lightning, Plus } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { AddSubscriptionDialog } from '@/app/components/features/events/add-subscription-dialog';
import { SubscriptionCard } from '@/app/components/features/events/subscription-card';
import { Button } from '@/app/components/ui/button';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import type {
  CreateSubscriptionInput,
  EventSource,
  EventSubscription,
  UpdateSubscriptionInput,
} from '@/lib/events/types';

export const Route = createFileRoute('/events/subscriptions')({
  component: SubscriptionsPage,
});

function SubscriptionsPage(): React.JSX.Element {
  const [subscriptions, setSubscriptions] = useState<EventSubscription[]>([]);
  const [sources, setSources] = useState<EventSource[]>([]);
  const [codespaces, setCodespaces] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editSubscription, setEditSubscription] = useState<EventSubscription | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    const res = await apiClient.events.subscriptions.list();
    if (res.ok) setSubscriptions(res.data.items);
  }, []);

  useMountEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [subsRes, sourcesRes, codespacesRes] = await Promise.all([
          apiClient.events.subscriptions.list(),
          apiClient.events.sources.list(),
          apiClient.codespaces.list(),
        ]);
        if (cancelled) return;
        if (subsRes.ok) setSubscriptions(subsRes.data.items);
        if (sourcesRes.ok) setSources(sourcesRes.data.items);
        if (codespacesRes.ok)
          setCodespaces(codespacesRes.data.items.map((c) => ({ id: c.id, name: c.name })));
      } catch {
        // Network errors handled gracefully — empty state shown
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  });

  const handleSave = useCallback(
    async (data: CreateSubscriptionInput | UpdateSubscriptionInput, id?: string) => {
      if (id) {
        const res = await apiClient.events.subscriptions.update(
          id,
          data as UpdateSubscriptionInput
        );
        if (!res.ok) throw new Error(res.error?.message ?? 'Failed to update');
      } else {
        const res = await apiClient.events.subscriptions.create(data as CreateSubscriptionInput);
        if (!res.ok) throw new Error(res.error?.message ?? 'Failed to create');
      }
      await fetchSubscriptions();
    },
    [fetchSubscriptions]
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        const res = await apiClient.events.subscriptions.update(id, { isEnabled: enabled });
        if (!res.ok) throw new Error(res.error?.message ?? 'Failed to toggle');
        await fetchSubscriptions();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to toggle subscription');
      }
    },
    [fetchSubscriptions]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this subscription? Events will no longer create tasks.')) return;
      try {
        const res = await apiClient.events.subscriptions.delete(id);
        if (!res.ok) throw new Error(res.error?.message ?? 'Failed to delete');
        await fetchSubscriptions();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to delete subscription');
      }
    },
    [fetchSubscriptions]
  );

  if (isLoading) {
    return (
      <output
        className="flex flex-1 items-center justify-center"
        aria-label="Loading subscriptions"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </output>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Subscriptions</h2>
        <Button
          onClick={() => {
            setEditSubscription(null);
            setShowDialog(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add Subscription
        </Button>
      </div>

      {subscriptions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={Lightning}
            title="No Subscriptions"
            subtitle="Create a subscription to automatically create tasks from events"
            primaryAction={{
              label: 'Add Subscription',
              onClick: () => {
                setEditSubscription(null);
                setShowDialog(true);
              },
              icon: <Plus className="h-4 w-4" />,
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {subscriptions.map((sub) => (
            <SubscriptionCard
              key={sub.id}
              subscription={sub}
              sourceName={sources.find((s) => s.id === sub.eventSourceId)?.name}
              codespaceName={codespaces.find((c) => c.id === sub.targetCodespaceId)?.name}
              onEdit={() => {
                setEditSubscription(sub);
                setShowDialog(true);
              }}
              onToggle={(enabled) => handleToggle(sub.id, enabled)}
              onDelete={() => handleDelete(sub.id)}
            />
          ))}
        </div>
      )}

      <AddSubscriptionDialog
        key={editSubscription?.id ?? 'new'}
        open={showDialog}
        onClose={() => {
          setShowDialog(false);
          setEditSubscription(null);
        }}
        onSave={handleSave}
        sources={sources}
        codespaces={codespaces}
        editSubscription={editSubscription}
      />
    </div>
  );
}
