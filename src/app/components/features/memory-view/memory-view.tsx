import { Brain, ChartBar, Lightbulb, Sparkle } from '@phosphor-icons/react';
import React, { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { Button } from '@/app/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { MemoryProvider, useMemory } from './memory-context';
import type { MemoryTab } from './types';

class MemoryTabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[MemoryView] Tab render error:', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-danger font-medium">Failed to load tab</p>
          <p className="mt-1 text-xs text-fg-muted">{this.state.error.message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4">
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
            <Sparkle size={14} />
            Upskill
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <MemoryTabErrorBoundary>
            <Suspense fallback={TAB_LOADING_FALLBACK}>
              <MemoryOverview />
            </Suspense>
          </MemoryTabErrorBoundary>
        </TabsContent>

        <TabsContent value="insights">
          <MemoryTabErrorBoundary>
            <Suspense fallback={TAB_LOADING_FALLBACK}>
              <MemoryInsightsTab />
            </Suspense>
          </MemoryTabErrorBoundary>
        </TabsContent>

        <TabsContent value="skills">
          <MemoryTabErrorBoundary>
            <Suspense fallback={TAB_LOADING_FALLBACK}>
              <MemorySkillsTab />
            </Suspense>
          </MemoryTabErrorBoundary>
        </TabsContent>

        <TabsContent value="dream">
          <MemoryTabErrorBoundary>
            <Suspense fallback={TAB_LOADING_FALLBACK}>
              <MemoryDreamTab />
            </Suspense>
          </MemoryTabErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}
