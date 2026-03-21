import { Check, GithubLogo, Notebook, Sparkle, Spinner, Stop, X } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { ErrorState } from '@/app/components/features/error-state';
import { Skeleton } from '@/app/components/ui/skeleton';
import { cn } from '@/lib/utils/cn';
import { PlanInputArea } from './plan-input-area';
import { PlanInteraction } from './plan-interaction';
import { PlanStreamPanel } from './plan-stream-panel';
import type { PlanSessionViewProps } from './types';
import { usePlanSession } from './use-plan-session';

/**
 * Static loading skeleton for the plan session view.
 * Hoisted to module scope since it produces identical JSX on every render.
 */
const planLoadingSkeleton = (
  <div className="flex flex-col h-full" data-testid="plan-skeleton">
    {/* Header skeleton */}
    <div className="flex items-center justify-between px-5 py-4 border-b border-border">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-5 w-28" />
      </div>
      <Skeleton className="h-8 w-20 rounded-md" />
    </div>

    {/* Stream panel skeleton */}
    <div className="flex-1 p-5 space-y-4 overflow-hidden">
      <div className="space-y-4">
        <div className="flex gap-3">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>

    {/* Input area skeleton */}
    <div className="p-4 border-t border-border">
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  </div>
);

/**
 * Completion banner showing GitHub issue link
 */
function CompletionBanner({
  issueUrl,
  issueNumber,
}: {
  issueUrl?: string;
  issueNumber?: number;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-xl p-4 mx-4',
        'bg-gradient-to-r from-success/10 via-success/5 to-transparent',
        'border border-success/30'
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          'bg-success/20 text-success',
          'shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]'
        )}
      >
        <Check className="h-5 w-5" weight="bold" />
      </div>
      <div className="flex-1">
        <h4 className="font-semibold text-fg">Plan Completed</h4>
        {issueUrl && issueNumber ? (
          <p className="text-sm text-fg-muted">
            Created GitHub Issue{' '}
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                'text-accent bg-accent/10 hover:bg-accent/20',
                'transition-colors duration-150'
              )}
            >
              <GithubLogo className="h-3.5 w-3.5" weight="fill" />#{issueNumber}
            </a>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">The planning session has been completed.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Welcome state when no session exists yet
 */
function WelcomeState(): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div
        className={cn(
          'flex h-16 w-16 items-center justify-center rounded-2xl mb-6',
          'bg-gradient-to-br from-secondary/20 to-secondary/5',
          'border border-secondary/20',
          'shadow-lg shadow-secondary/5'
        )}
      >
        <Sparkle className="h-8 w-8 text-secondary" weight="fill" />
      </div>
      <h3 className="text-lg font-semibold text-fg mb-2">Start Planning with Claude</h3>
      <p className="text-sm text-fg-muted max-w-sm mb-6 leading-relaxed">
        Describe what you want to build or accomplish. Claude will help you create a detailed plan,
        ask clarifying questions, and break down the work into actionable steps.
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {['Architecture design', 'Feature breakdown', 'API design', 'Implementation strategy'].map(
          (tag) => (
            <span
              key={tag}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium',
                'bg-surface-muted text-fg-muted border border-border/50'
              )}
            >
              {tag}
            </span>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Main plan session view component
 */
export function PlanSessionView({
  taskId,
  codespaceId,
  onSessionEnd,
  onError,
}: PlanSessionViewProps): React.JSX.Element {
  const { state, startSession, answerInteraction, cancelSession } = usePlanSession(
    taskId,
    codespaceId,
    { onError }
  );

  const [isCancelling, setIsCancelling] = useState(false);

  const handleStartSession = useCallback(
    (prompt: string) => {
      startSession(prompt);
    },
    [startSession]
  );

  const handleAnswerInteraction = useCallback(
    (interactionId: string, answers: Record<string, string>) => {
      answerInteraction(interactionId, answers);
    },
    [answerInteraction]
  );

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    await cancelSession();
    setIsCancelling(false);
    onSessionEnd?.();
  }, [cancelSession, onSessionEnd]);

  // Loading state
  if (state.isLoading) {
    return planLoadingSkeleton;
  }

  // Error state
  if (state.error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <ErrorState
          title="Plan Session Error"
          description={state.error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const isSessionActive =
    state.session?.status === 'active' || state.session?.status === 'waiting_user';
  const isCompleted = state.session?.status === 'completed';
  const isCancelled = state.session?.status === 'cancelled';
  const hasSession = state.session !== null;
  const hasMessages = state.messages.length > 0;

  return (
    <div className="flex flex-col h-full bg-canvas">
      {/* Header - refined styling */}
      <div
        className={cn(
          'flex items-center justify-between px-5 py-3',
          'border-b border-border',
          'bg-gradient-to-r from-surface via-surface to-surface-subtle'
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg',
              'bg-secondary/10 text-secondary',
              'border border-secondary/20'
            )}
          >
            <Notebook className="h-4 w-4" weight="fill" />
          </div>
          <div className="flex flex-col">
            <h3 className="text-sm font-semibold text-fg">Planning Session</h3>
            {state.session && (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider',
                  isSessionActive && 'text-secondary',
                  isCompleted && 'text-success',
                  isCancelled && 'text-fg-muted'
                )}
              >
                {isSessionActive && (
                  <>
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75 animate-ping" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-secondary" />
                    </span>
                    Active
                  </>
                )}
                {isCompleted && (
                  <>
                    <Check className="h-3 w-3" weight="bold" />
                    Completed
                  </>
                )}
                {isCancelled && 'Cancelled'}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isSessionActive && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={isCancelling}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                'border border-danger/30 text-danger',
                'hover:bg-danger/10 active:bg-danger/20',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-all duration-150'
              )}
            >
              {isCancelling ? (
                <Spinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Stop className="h-3.5 w-3.5" weight="bold" />
              )}
              Stop
            </button>
          )}

          {(isCompleted || isCancelled) && onSessionEnd && (
            <button
              type="button"
              onClick={onSessionEnd}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                'border border-border text-fg-muted',
                'hover:bg-surface-muted active:bg-surface-emphasis',
                'transition-all duration-150'
              )}
            >
              <X className="h-3.5 w-3.5" />
              Close
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Completion banner */}
        {isCompleted && state.completionInfo && (
          <div className="pt-4">
            <CompletionBanner
              issueUrl={state.completionInfo.issueUrl}
              issueNumber={state.completionInfo.issueNumber}
            />
          </div>
        )}

        {/* Welcome state or Stream panel */}
        {!hasSession && !hasMessages ? (
          <WelcomeState />
        ) : (
          <div className="flex-1 overflow-hidden">
            <PlanStreamPanel
              messages={state.messages}
              streamingContent={state.streamingContent}
              isStreaming={state.isStreaming}
            />
          </div>
        )}

        {/* Interaction modal */}
        {state.pendingInteraction && (
          <PlanInteraction
            interaction={state.pendingInteraction}
            // biome-ignore lint/style/noNonNullAssertion: guarded by state.pendingInteraction && check above
            onAnswer={(answers) => handleAnswerInteraction(state.pendingInteraction!.id, answers)}
            isSubmitting={state.isStreaming}
          />
        )}
      </div>

      {/* Input area - only show for active sessions or to start new session */}
      {(!hasSession || isSessionActive) && !state.pendingInteraction && (
        <PlanInputArea
          onSubmit={handleStartSession}
          disabled={state.isStreaming || (hasSession && !isSessionActive)}
          placeholder={
            hasSession
              ? 'Continue the conversation...'
              : 'What would you like to plan? Describe your goal...'
          }
        />
      )}
    </div>
  );
}

export { PlanInputArea } from './plan-input-area';
export { PlanInteraction } from './plan-interaction';
export { PlanStreamPanel } from './plan-stream-panel';
// Re-export types and components
export * from './types';
export { usePlanSession } from './use-plan-session';
