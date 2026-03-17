import { Square } from '@phosphor-icons/react';
import { memo, useState } from 'react';
import { AgentTopology } from '@/app/components/features/agent-topology';
import { Button } from '@/app/components/ui/button';
import { useContainerAgent } from '@/app/hooks/use-container-agent';
import { cn } from '@/lib/utils/cn';
import { ContainerAgentChangesTab } from './container-agent-changes-tab';
import { ContainerAgentHeader } from './container-agent-header';
import { ContainerAgentStatusBreadcrumbs } from './container-agent-status-breadcrumbs';
import { ContainerAgentStream } from './container-agent-stream';
import { ContainerAgentToolList } from './container-agent-tool-list';

type PanelTab = 'output' | 'changes' | 'topology';

const TopologyTab = memo(function TopologyTab({
  sessionId,
}: {
  sessionId?: string;
}): React.JSX.Element {
  return <AgentTopology sessionId={sessionId} />;
});

export interface ContainerAgentPanelProps {
  /** Session ID to subscribe to */
  sessionId: string | null;
  /** Sandbox provider from session record (fallback when stream events lack it) */
  sandboxProvider?: string;
  /** Callback when stop is requested */
  onStop?: () => Promise<void>;
  /** Callback when plan is approved */
  onApprovePlan?: () => void;
  /** Callback when plan is rejected */
  onRejectPlan?: () => void;
  /** Whether a plan action is in progress */
  isPlanActionPending?: boolean;
}

/**
 * Container Agent Panel - Displays real-time container agent execution
 *
 * Shows:
 * - Agent status and turn counter
 * - Streaming token output
 * - Tool execution progress
 * - Final result or error
 */
export function ContainerAgentPanel({
  sessionId,
  sandboxProvider: sessionSandboxProvider,
  onStop,
  onApprovePlan,
  onRejectPlan,
  isPlanActionPending,
}: ContainerAgentPanelProps): React.JSX.Element {
  const { state, connectionState, isStreaming } = useContainerAgent(sessionId);
  const [activeTab, setActiveTab] = useState<PanelTab>('output');

  const isActive = state.status === 'running' || state.status === 'starting';
  const hasChanges = state.fileChanges.length > 0;
  // Prefer stream event provider, fall back to session record
  const resolvedProvider = state.sandboxProvider ?? sessionSandboxProvider;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col rounded-lg border border-border bg-surface">
      {/* Header with status and controls */}
      <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-4 py-3">
        <ContainerAgentHeader
          status={state.status}
          model={state.model}
          branch={state.branch}
          currentTurn={state.currentTurn}
          maxTurns={state.maxTurns}
          startedAt={state.startedAt}
          sandboxProvider={resolvedProvider}
          sandboxContainerId={state.sandboxContainerId}
          connectionState={connectionState}
          isStreaming={isStreaming}
        />

        {/* Stop button */}
        {isActive && onStop ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void onStop()}
            data-testid="stop-agent-button"
          >
            <Square className="h-4 w-4" weight="fill" />
            Stop
          </Button>
        ) : null}
      </div>

      {/* Status breadcrumbs during startup */}
      {state.status === 'starting' && state.statusHistory.length > 0 ? (
        <ContainerAgentStatusBreadcrumbs
          currentStage={state.currentStage}
          statusMessage={state.statusMessage}
          statusHistory={state.statusHistory}
        />
      ) : null}

      {/* Tab bar */}
      <div className="flex border-b border-border bg-surface-subtle" data-testid="panel-tabs">
        <button
          type="button"
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'output'
              ? 'border-b-2 border-accent text-fg'
              : 'text-fg-muted hover:text-fg'
          )}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>
        {hasChanges ? (
          <button
            type="button"
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === 'changes'
                ? 'border-b-2 border-accent text-fg'
                : 'text-fg-muted hover:text-fg'
            )}
            onClick={() => setActiveTab('changes')}
          >
            Changes
            <span className="ml-1.5 rounded-full bg-surface-subtle px-1.5 py-0.5 text-xs tabular-nums">
              {state.fileChanges.length}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'topology'
              ? 'border-b-2 border-accent text-fg'
              : 'text-fg-muted hover:text-fg'
          )}
          onClick={() => setActiveTab('topology')}
        >
          Topology
        </button>
      </div>

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        {activeTab === 'output' ? (
          <>
            {/* Stream output */}
            <div className="flex-1 min-h-0 min-w-0 flex flex-col">
              <ContainerAgentStream
                streamedText={state.streamedText}
                messages={state.messages}
                isStreaming={isStreaming}
                result={state.result}
                error={state.error}
                status={state.status}
                statusMessage={state.statusMessage}
                plan={state.plan}
                onApprovePlan={state.status === 'plan_ready' ? onApprovePlan : undefined}
                onRejectPlan={state.status === 'plan_ready' ? onRejectPlan : undefined}
                isPlanActionPending={isPlanActionPending}
              />
            </div>

            {/* Tool executions sidebar */}
            {state.toolExecutions.length > 0 ? (
              <div className="flex flex-col min-h-0 w-full border-t border-border lg:w-96 lg:border-l lg:border-t-0">
                <ContainerAgentToolList tools={state.toolExecutions} />
              </div>
            ) : null}
          </>
        ) : activeTab === 'changes' ? (
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <ContainerAgentChangesTab fileChanges={state.fileChanges} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <TopologyTab sessionId={sessionId ?? undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
