import { ArrowsClockwise, Plus, PuzzlePiece, Spinner } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AddMarketplaceDialog } from '@/app/components/features/add-marketplace-dialog';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { type CachedPlugin, MarketplaceCard } from '@/app/components/features/marketplace-card';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';

// Marketplace syncs with: https://github.com/anthropics/claude-plugins-official
//   - /plugins (internal Anthropic plugins)
//   - /external_plugins (third-party community plugins)

export const Route = createFileRoute('/marketplace/')({
  loader: async () => {
    await apiClient.marketplaces.seed();
    const [marketplacesRes, pluginsRes] = await Promise.all([
      apiClient.marketplaces.list(),
      apiClient.marketplaces.listPlugins({}),
    ]);
    return {
      marketplaces: marketplacesRes.ok ? marketplacesRes.data.items : [],
      plugins: pluginsRes.ok ? pluginsRes.data.items : [],
    };
  },
  component: MarketplacePage,
});

type MarketplaceItem = {
  id: string;
  name: string;
  githubOwner: string;
  githubRepo: string;
  branch: string;
  pluginsPath: string;
  isDefault: boolean;
  isEnabled: boolean;
  status: 'active' | 'syncing' | 'error';
  lastSyncedAt: string | null;
  syncError: string | null;
  pluginCount: number;
  createdAt: string;
  updatedAt: string;
};

type PluginItem = {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  category?: string;
  marketplaceId: string;
  marketplaceName: string;
  isEnabled: boolean;
};

function MarketplacePage(): React.JSX.Element {
  const loaderData = Route.useLoaderData() as
    | { marketplaces: MarketplaceItem[]; plugins: PluginItem[] }
    | undefined;
  const [marketplaces, setMarketplaces] = useState<MarketplaceItem[]>(
    () => (loaderData?.marketplaces as MarketplaceItem[]) ?? []
  );
  const [plugins, setPlugins] = useState<PluginItem[]>(
    () => (loaderData?.plugins as PluginItem[]) ?? []
  );
  const [isLoading, setIsLoading] = useState(!loaderData?.marketplaces);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [isAddingMarketplace, setIsAddingMarketplace] = useState(false);

  // Track if we've already tried auto-syncing to avoid repeated attempts (use ref to avoid dependency issues)
  const hasAutoSyncedRef = useRef(false);

  // Fetch data
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // First, seed the default marketplace if needed
      await apiClient.marketplaces.seed();

      // Fetch marketplaces and plugins in parallel
      const [marketplacesRes, pluginsRes] = await Promise.all([
        apiClient.marketplaces.list(),
        apiClient.marketplaces.listPlugins({}),
      ]);

      if (marketplacesRes.ok) {
        setMarketplaces(marketplacesRes.data.items);

        // Auto-sync marketplaces that have never been synced (first time setup)
        if (!hasAutoSyncedRef.current) {
          const unsyncedMarketplaces = marketplacesRes.data.items.filter(
            (m) => m.lastSyncedAt === null && m.status !== 'syncing'
          );

          if (unsyncedMarketplaces.length > 0) {
            hasAutoSyncedRef.current = true;
            // Sync unsynced marketplaces in the background
            for (const marketplace of unsyncedMarketplaces) {
              setSyncingIds((prev) => new Set(prev).add(marketplace.id));
              apiClient.marketplaces
                .sync(marketplace.id)
                .then(async (result) => {
                  setSyncingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(marketplace.id);
                    return next;
                  });
                  // Refetch data after successful sync
                  if (result.ok) {
                    const [newMarketplaces, newPlugins] = await Promise.all([
                      apiClient.marketplaces.list(),
                      apiClient.marketplaces.listPlugins({}),
                    ]);
                    if (newMarketplaces.ok) setMarketplaces(newMarketplaces.data.items);
                    if (newPlugins.ok) setPlugins(newPlugins.data.items);
                  } else {
                    console.error(
                      `[Marketplace] Auto-sync failed for ${marketplace.id}:`,
                      result.error
                    );
                  }
                })
                .catch((err) => {
                  console.error(`[Marketplace] Auto-sync error for ${marketplace.id}:`, err);
                  setSyncingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(marketplace.id);
                    return next;
                  });
                });
            }
          }
        }
      } else {
        console.error('[Marketplace] Failed to fetch marketplaces:', marketplacesRes.error);
        setError(marketplacesRes.error?.message ?? 'Failed to load marketplaces');
      }

      if (pluginsRes.ok) {
        setPlugins(pluginsRes.data.items);
      } else {
        console.error('[Marketplace] Failed to fetch plugins:', pluginsRes.error);
      }
    } catch (err) {
      console.error('[Marketplace] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load marketplace data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useWatchEffect(() => {
    fetchData();
  }, [fetchData]);

  // Handler for syncing a marketplace
  const handleSyncMarketplace = async (id: string) => {
    setSyncingIds((prev) => new Set(prev).add(id));
    try {
      const result = await apiClient.marketplaces.sync(id);
      if (result.ok) {
        // Refresh data after sync
        await fetchData();
      } else {
        console.error(`[Marketplace] Sync failed for ${id}:`, result.error);
        setError(result.error?.message ?? 'Failed to sync marketplace');
      }
    } catch (err) {
      console.error(`[Marketplace] Sync error for ${id}:`, err);
      setError(err instanceof Error ? err.message : 'Failed to sync marketplace');
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Handler for adding a new marketplace
  const handleAddMarketplace = async (data: {
    name: string;
    githubUrl: string;
    branch?: string;
  }) => {
    setIsAddingMarketplace(true);
    try {
      const result = await apiClient.marketplaces.create({
        name: data.name,
        githubUrl: data.githubUrl,
        branch: data.branch,
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Sync the newly added marketplace
      await apiClient.marketplaces.sync(result.data.id);

      // Refresh data
      await fetchData();
    } finally {
      setIsAddingMarketplace(false);
    }
  };

  // Handler for removing a marketplace
  const handleRemoveMarketplace = async (id: string) => {
    const confirmed = window.confirm('Are you sure you want to remove this marketplace?');
    if (!confirmed) return;

    try {
      const result = await apiClient.marketplaces.delete(id);
      if (result.ok) {
        await fetchData();
      } else {
        console.error(`[Marketplace] Delete failed for ${id}:`, result.error);
        setError(result.error?.message ?? 'Failed to remove marketplace');
      }
    } catch (err) {
      console.error(`[Marketplace] Delete error for ${id}:`, err);
      setError(err instanceof Error ? err.message : 'Failed to remove marketplace');
    }
  };

  // Pre-group plugins by marketplace ID for O(1) lookup
  const pluginsByMarketplace = useMemo(() => {
    const map = new Map<string, CachedPlugin[]>();
    for (const p of plugins) {
      const list = map.get(p.marketplaceId) || [];
      list.push({
        id: p.id,
        name: p.name,
        description: p.description,
        author: p.author,
        version: p.version,
        category: p.category,
      });
      map.set(p.marketplaceId, list);
    }
    return map;
  }, [plugins]);

  // Loading state
  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Content' }, { label: 'Marketplace' }]}>
        <div className="flex items-center justify-center min-h-[60vh]" data-testid="loading-state">
          <div className="flex items-center gap-2 text-fg-muted">
            <Spinner className="h-5 w-5 animate-spin" />
            Loading marketplace...
          </div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Content' }, { label: 'Marketplace' }]}
      actions={
        <Button onClick={() => setShowAddDialog(true)} data-testid="add-marketplace-button">
          <Plus className="h-4 w-4" />
          Add Marketplace
        </Button>
      }
    >
      <div data-testid="marketplace-page" className="p-6">
        {/* Error state */}
        {error ? (
          <div className="mb-6 p-4 rounded-xl bg-danger-muted/50 border border-danger/20 text-sm text-danger flex items-center justify-between">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={fetchData} className="ml-4 shrink-0">
              Retry
            </Button>
          </div>
        ) : null}

        {/* Empty state - no marketplaces */}
        {marketplaces.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60vh]">
            <EmptyState
              icon={PuzzlePiece}
              title="No Marketplaces Connected"
              subtitle="Connect to plugin marketplaces to discover and install Claude plugins. Add a custom marketplace or wait for the official Anthropic marketplace to sync."
              primaryAction={{
                label: 'Add Marketplace',
                onClick: () => setShowAddDialog(true),
              }}
            />
          </div>
        ) : (
          /* Marketplace cards - single column, left-aligned */
          <div className="flex flex-col gap-5" data-testid="marketplace-grid">
            {marketplaces.map((marketplace) => {
              const marketplacePlugins = pluginsByMarketplace.get(marketplace.id) ?? [];
              const hasPlugins = marketplacePlugins.length > 0;
              return (
                <div
                  key={marketplace.id}
                  className={hasPlugins ? 'max-w-4xl' : 'max-w-2xl'}
                  style={{ transition: 'max-width 0.3s ease-out' }}
                >
                  <MarketplaceCard
                    marketplace={marketplace}
                    plugins={marketplacePlugins}
                    onSync={() => handleSyncMarketplace(marketplace.id)}
                    onRemove={
                      marketplace.isDefault
                        ? undefined
                        : () => handleRemoveMarketplace(marketplace.id)
                    }
                    isSyncing={syncingIds.has(marketplace.id)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Syncing indicator for auto-sync */}
        {syncingIds.size > 0 && plugins.length === 0 ? (
          <div className="mt-8 flex items-center justify-center py-8">
            <div className="flex items-center gap-3 text-fg-muted bg-surface-subtle px-5 py-3 rounded-full">
              <ArrowsClockwise className="h-4 w-4 animate-spin text-accent" />
              <span className="text-sm">Syncing plugins from GitHub...</span>
            </div>
          </div>
        ) : null}

        {/* Add Marketplace Dialog */}
        <AddMarketplaceDialog
          open={showAddDialog}
          onClose={() => setShowAddDialog(false)}
          onAdd={handleAddMarketplace}
          isAdding={isAddingMarketplace}
        />
      </div>
    </LayoutShell>
  );
}
