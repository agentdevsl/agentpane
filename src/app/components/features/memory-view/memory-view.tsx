import { Brain, ChartBar, Lightbulb, SunHorizon } from '@phosphor-icons/react';
import React, { Suspense } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { MemoryProvider, useMemory } from './memory-context';
import type { MemoryTab } from './types';

const MemoryOverview = React.lazy(() =>
  import('./memory-overview').then((m) => ({ default: m.MemoryOverview }))
);
const MemoryInsightsTab = React.lazy(() =>
  import('./memory-insights-tab').then((m) => ({ default: m.MemoryInsightsTab }))
);
const MemorySkillsTab = React.lazy(() =>
  import('./memory-skills-tab').then((m) => ({ default: m.MemorySkillsTab }))
);
const MemoryDreamTab = React.lazy(() =>
  import('./memory-dream-tab').then((m) => ({ default: m.MemoryDreamTab }))
);

interface MemoryViewProps {
  codespaceId: string | null;
}

export function MemoryView({ codespaceId }: MemoryViewProps): React.JSX.Element {
  if (!codespaceId) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-fg-muted text-sm">Select a codespace to view memory data</p>
      </div>
    );
  }

  return (
    <MemoryProvider codespaceId={codespaceId}>
      <MemoryViewInner />
    </MemoryProvider>
  );
}

const TAB_LOADING_FALLBACK = (
  <div className="flex items-center justify-center py-12">
    <div className="text-fg-muted text-sm">Loading...</div>
  </div>
);

function MemoryViewInner(): React.JSX.Element {
  const { activeTab, setActiveTab } = useMemory();

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <Tabs value={activeTab} onValueChange={(value: string) => setActiveTab(value as MemoryTab)}>
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <Brain size={14} />
            Overview
          </TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5">
            <Lightbulb size={14} />
            Insights
          </TabsTrigger>
          <TabsTrigger value="skills" className="gap-1.5">
            <ChartBar size={14} />
            Skills
          </TabsTrigger>
          <TabsTrigger value="dream" className="gap-1.5">
            <SunHorizon size={14} />
            Dreams
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Suspense fallback={TAB_LOADING_FALLBACK}>
            <MemoryOverview />
          </Suspense>
        </TabsContent>

        <TabsContent value="insights">
          <Suspense fallback={TAB_LOADING_FALLBACK}>
            <MemoryInsightsTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="skills">
          <Suspense fallback={TAB_LOADING_FALLBACK}>
            <MemorySkillsTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="dream">
          <Suspense fallback={TAB_LOADING_FALLBACK}>
            <MemoryDreamTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
