import {
  CheckCircle,
  CircleNotch,
  Lightning,
  Terminal,
  Warning,
  XCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { MarkdownContent } from '@/app/components/ui/markdown-content';
import type { ContainerAgentStatus } from './container-agent-header';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface ContainerAgentStreamProps {
  streamedText: string;
  messages: Message[];
  isStreaming: boolean;
  result?: string;
  error?: string;
  status: ContainerAgentStatus;
  statusMessage?: string;
  /** Plan content when plan_ready */
  plan?: string;
  /** Callback to approve the plan */
  onApprovePlan?: () => void;
  /** Callback to reject the plan */
  onRejectPlan?: () => void;
  /** Whether an approve/reject action is in progress */
  isPlanActionPending?: boolean;
}

/**
 * Blinking cursor component for streaming
 */
function StreamCursor(): React.JSX.Element {
  return (
    <span className="inline-block h-4 w-2 animate-pulse bg-accent" data-testid="stream-cursor" />
  );
}

export function ContainerAgentStream({
  streamedText,
  messages,
  isStreaming,
  result,
  error,
  status,
  statusMessage,
  plan,
  onApprovePlan,
  onRejectPlan,
  isPlanActionPending,
}: ContainerAgentStreamProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const userScrolledRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll to bottom when content changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally trigger on content changes
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [streamedText, messages]);

  // Detect user scroll
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!isAtBottom && !userScrolledRef.current) {
      userScrolledRef.current = true;
      autoScrollRef.current = false;
      setShowScrollButton(true);
    }

    if (isAtBottom && userScrolledRef.current) {
      userScrolledRef.current = false;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      autoScrollRef.current = true;
      userScrolledRef.current = false;
      setShowScrollButton(false);
    }
  }, []);

  const hasContent = messages.length > 0 || streamedText.length > 0;

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-4 py-2">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Terminal className="h-4 w-4" weight="bold" />
          <span className="font-medium">Agent Output</span>
          {isStreaming ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
          ) : null}
        </div>
      </div>

      {/* Stream content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden bg-canvas p-4 font-mono text-sm"
        data-testid="container-agent-output"
      >
        {!hasContent && (status === 'idle' || status === 'starting') ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            {/* Glowing spinner orb */}
            <div className="relative flex items-center justify-center">
              <div className="absolute h-16 w-16 animate-pulse rounded-full bg-accent/20 blur-xl" />
              <div className="relative flex h-12 w-12 items-center justify-center rounded-full border border-accent/30 bg-accent/10">
                <CircleNotch className="h-6 w-6 animate-spin text-accent" />
              </div>
            </div>
            {/* Status text */}
            <div className="text-center">
              <p className="text-sm font-medium text-fg-muted">
                {status === 'starting'
                  ? statusMessage || 'Starting agent...'
                  : 'Waiting for agent...'}
              </p>
              <p className="mt-1 text-xs text-fg-subtle">Output will stream here in real time</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Previous messages */}
            {messages.map((msg, index) => (
              <div
                key={`${msg.timestamp}-${index}`}
                className={`[content-visibility:auto] [contain-intrinsic-size:0_80px] rounded-lg p-3 ${
                  msg.role === 'assistant'
                    ? 'bg-surface border border-border'
                    : 'bg-accent/10 border border-accent/20'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium capitalize">{msg.role}</span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="whitespace-pre-wrap text-fg">{msg.content}</div>
              </div>
            ))}

            {/* Currently streaming text */}
            {streamedText ? (
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium">Assistant</span>
                  {isStreaming ? <span className="text-success">Streaming...</span> : null}
                </div>
                <div className="whitespace-pre-wrap text-fg">
                  {streamedText}
                  {isStreaming ? <StreamCursor /> : null}
                </div>
              </div>
            ) : null}

            {/* Plan review */}
            {status === 'plan_ready' && plan ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-attention/30 bg-attention/5 p-4">
                  <div className="mb-3 flex items-center gap-2 text-attention">
                    <Lightning className="h-4 w-4" weight="fill" />
                    <span className="text-sm font-semibold">Implementation Plan</span>
                  </div>
                  <div className="rounded-lg border border-border bg-bg-default p-4">
                    <MarkdownContent
                      content={plan}
                      className="prose prose-sm dark:prose-invert max-w-none text-fg"
                    />
                  </div>
                </div>

                {/* Approve/Reject buttons */}
                {onApprovePlan || onRejectPlan ? (
                  <div className="flex items-center justify-end gap-3">
                    {onRejectPlan ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={onRejectPlan}
                        disabled={isPlanActionPending}
                        className="gap-1.5 bg-danger/10 text-danger ring-1 ring-danger/20 hover:bg-danger/20 hover:ring-danger/40"
                        data-testid="reject-plan-button"
                      >
                        <XCircle className="h-4 w-4" weight="bold" />
                        Reject Plan
                      </Button>
                    ) : null}
                    {onApprovePlan ? (
                      <Button
                        size="sm"
                        onClick={onApprovePlan}
                        disabled={isPlanActionPending}
                        className="gap-1.5 bg-success text-white shadow-lg shadow-success/25 hover:bg-success/90"
                        data-testid="approve-plan-button"
                      >
                        {isPlanActionPending ? (
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        ) : (
                          <CheckCircle className="h-4 w-4" weight="bold" />
                        )}
                        Approve Plan
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Final result (non-plan) */}
            {status === 'completed' && result && !plan ? (
              <div className="rounded-lg border border-success/30 bg-success/10 p-3">
                <div className="mb-2 flex items-center gap-2 text-success">
                  <CheckCircle className="h-4 w-4" weight="fill" />
                  <span className="text-sm font-medium">Completed</span>
                </div>
                <div className="whitespace-pre-wrap text-sm text-fg">{result}</div>
              </div>
            ) : null}

            {/* Cancelled state */}
            {status === 'cancelled' ? (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
                <div className="flex items-center gap-2 text-warning">
                  <Warning className="h-4 w-4" weight="fill" />
                  <span className="text-sm font-medium">Cancelled</span>
                </div>
              </div>
            ) : null}

            {/* Error state */}
            {status === 'error' && error ? (
              <div className="rounded-lg border border-danger/30 bg-danger/10 p-3">
                <div className="mb-2 flex items-center gap-2 text-danger">
                  <XCircle className="h-4 w-4" weight="fill" />
                  <span className="text-sm font-medium">Error</span>
                </div>
                <div className="whitespace-pre-wrap text-sm text-fg">{error}</div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && hasContent ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lg transition-opacity hover:bg-accent-hover"
        >
          Scroll to bottom
        </button>
      ) : null}
    </div>
  );
}
