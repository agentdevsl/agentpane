import { createFileRoute } from '@tanstack/react-router';
import React, { Suspense, useState } from 'react';
import { LayoutShell } from '@/app/components/features/layout-shell';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { useCodespaceData } from '@/app/providers/codespace-context';
import { apiClient } from '@/lib/api/client';

interface Codespace {
  id: string;
  name: string;
}

const ALL_CODESPACES = '__all__';

const MemoryView = React.lazy(() =>
  import('@/app/components/features/memory-view').then((m) => ({ default: m.MemoryView }))
);

export const Route = createFileRoute('/memory/')({
  loader: async () => {
    const result = await apiClient.codespaces.list();
    if (!result.ok) {
      throw new Error(result.error?.message ?? 'Failed to load codespaces');
    }
    const codespaces = Array.isArray(result.data)
      ? result.data
      : ((result.data as { items?: Codespace[] }).items ?? []);
    return { codespaces };
  },
  component: MemoryPage,
});

function MemoryPage(): React.JSX.Element {
  const loaderData = Route.useLoaderData() as { codespaces: Codespace[] } | undefined;
  const codespaces = loaderData?.codespaces ?? [];

  const urlCodespaceId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('codespaceId')
      : null;

  const { currentCodespaceId } = useCodespaceData();

  // Default to global view (ALL_CODESPACES) unless a specific codespace is requested via URL or context
  const defaultSelected = urlCodespaceId ?? currentCodespaceId ?? ALL_CODESPACES;
  const [selected, setSelected] = useState<string>(defaultSelected);
  const codespaceId = selected === ALL_CODESPACES ? null : selected;

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Memory' }]}
      actions={
        codespaces.length > 0 ? (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select codespace" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CODESPACES}>All Codespaces</SelectItem>
              {codespaces.map((cs) => (
                <SelectItem key={cs.id} value={cs.id}>
                  {cs.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="text-fg-muted">Loading memory...</div>
          </div>
        }
      >
        <MemoryView codespaceId={codespaceId} />
      </Suspense>
    </LayoutShell>
  );
}
