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

const MemoryView = React.lazy(() =>
  import('@/app/components/features/memory-view').then((m) => ({ default: m.MemoryView }))
);

export const Route = createFileRoute('/memory/')({
  loader: async () => {
    const result = await apiClient.codespaces.list();
    if (!result.ok) {
      return { codespaces: [] as Codespace[] };
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

  const defaultId = urlCodespaceId ?? currentCodespaceId ?? codespaces[0]?.id ?? null;
  const [selectedCodespaceId, setSelectedCodespaceId] = useState<string | null>(defaultId);

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Memory' }]}
      actions={
        codespaces.length > 0 ? (
          <Select value={selectedCodespaceId ?? undefined} onValueChange={setSelectedCodespaceId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select codespace" />
            </SelectTrigger>
            <SelectContent>
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
        <MemoryView codespaceId={selectedCodespaceId} codespaces={codespaces} />
      </Suspense>
    </LayoutShell>
  );
}
