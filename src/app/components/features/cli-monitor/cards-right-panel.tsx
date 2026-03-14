import { ChatCircle, Clock, Lightning, Terminal } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { CliSession } from './cli-monitor-types';
import { estimateCost, formatTokenCount, getSessionTokenTotal } from './cli-monitor-utils';

type PanelTab = 'stream' | 'activity' | 'tokens';

interface CardsRightPanelProps {
  session: CliSession;
  onClose: () => void;
}

export function CardsRightPanel({ session, onClose }: CardsRightPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('stream');

  return (
    <div className="flex h-full flex-col border-l border-border bg-default">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-subtle shrink-0">
        {(['stream', 'activity', 'tokens'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors relative ${
              activeTab === tab ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {tab === 'stream' ? 'Live Stream' : tab === 'activity' ? 'Activity' : 'Tokens'}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          className="px-2.5 py-2 text-fg-subtle hover:text-fg"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'stream' && <StreamTab session={session} />}
        {activeTab === 'activity' && <ActivityTab session={session} />}
        {activeTab === 'tokens' && <TokensTab session={session} />}
      </div>

      {/* Bottom controls */}
      <div className="flex gap-2 border-t border-border bg-subtle p-3 shrink-0">
        <button
          type="button"
          disabled
          title="Actions not yet connected to daemon"
          className="flex-1 rounded bg-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Approve
        </button>
        <button
          type="button"
          disabled
          title="Actions not yet connected to daemon"
          className="flex-1 rounded border border-border bg-default px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send Input
        </button>
        <button
          type="button"
          disabled
          title="Actions not yet connected to daemon"
          className="flex-1 rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50 disabled:cursor-not-allowed hover:bg-danger/10"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function StreamTab({ session }: { session: CliSession }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recentOutput triggers auto-scroll on new output
  useEffect(() => {
    if (!contentRef.current || !isPinnedRef.current) return;
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [session.recentOutput]);

  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    isPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
  };

  const isWorking = session.status === 'working';
  const statusDot = {
    working: 'bg-success animate-pulse',
    waiting_for_approval: 'bg-attention',
    waiting_for_input: 'bg-accent',
    idle: 'bg-fg-subtle',
  }[session.status];

  return (
    <div className="flex h-full flex-col">
      {/* Stream header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${statusDot}`} />
        <span className="font-mono text-xs font-medium text-fg">
          {session.sessionId.slice(0, 8)}
        </span>
        {session.gitBranch && (
          <span className="rounded bg-[#a371f7]/15 px-1.5 py-0.5 text-[10px] font-mono font-medium text-[#a371f7]">
            {session.gitBranch}
          </span>
        )}
      </div>

      {/* Terminal output */}
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-[#0a0e14] p-3 font-mono text-[11px] leading-[1.7]"
      >
        {session.recentOutput ? (
          <>
            {session.recentOutput.split('\n').map((line, i) => (
              <StreamLine key={`${session.sessionId}-${i}`} line={line} />
            ))}
            {isWorking && (
              <span className="inline-block w-[7px] h-[13px] bg-[#a371f7] animate-[blink_1s_step-end_infinite] align-text-bottom ml-0.5" />
            )}
          </>
        ) : (
          <div className="text-fg-subtle italic">No output yet...</div>
        )}
      </div>
    </div>
  );
}

function StreamLine({ line }: { line: string }) {
  const userMatch = line.match(/^\[user\](.*)/);
  if (userMatch) {
    return (
      <div className="mb-px">
        <span className="text-accent font-semibold">[user]</span>
        <span className="text-fg-muted">{userMatch[1]}</span>
      </div>
    );
  }

  const claudeMatch = line.match(/^\[claude\](.*)/);
  if (claudeMatch) {
    return (
      <div className="mb-px">
        <span className="text-[#a371f7] font-semibold">[claude]</span>
        <span className="text-fg-muted">{claudeMatch[1]}</span>
      </div>
    );
  }

  const toolMatch = line.match(/^\[tool:([^\]]+)\](.*)/);
  if (toolMatch) {
    return (
      <div className="mb-px bg-attention/[0.06] border-l-2 border-attention pl-2 py-px my-0.5">
        <span className="text-attention font-semibold">[tool:{toolMatch[1]}]</span>
        <span className="text-fg-muted">{toolMatch[2]}</span>
      </div>
    );
  }

  const systemMatch = line.match(/^\[system\](.*)/);
  if (systemMatch) {
    return (
      <div className="mb-px">
        <span className="text-fg-subtle font-medium">[system]</span>
        <span className="text-fg-subtle">{systemMatch[1]}</span>
      </div>
    );
  }

  // Highlight file paths — use non-global regex for .test() to avoid lastIndex state issues
  const filePathPattern = /((?:\/[\w.-]+)+(?:\.\w+)?)/;
  if (filePathPattern.test(line)) {
    const parts = line.split(new RegExp(filePathPattern.source, 'g'));
    return (
      <div className="mb-px whitespace-pre-wrap break-words text-fg-muted">
        {parts.map((part, i) =>
          filePathPattern.test(part) ? (
            <span key={`${part}-${i}`} className="text-success">
              {part}
            </span>
          ) : (
            <span key={`${part}-${i}`}>{part}</span>
          )
        )}
      </div>
    );
  }

  return <div className="mb-px whitespace-pre-wrap break-words text-fg-muted">{line}</div>;
}

function ActivityTab({ session }: { session: CliSession }) {
  const durationMs = Date.now() - session.startedAt;
  const durationMin = Math.floor(durationMs / 60000);

  return (
    <div className="overflow-y-auto p-3">
      <div className="space-y-3">
        {/* Session info */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              Session Info
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  {
                    working: 'bg-success animate-pulse',
                    waiting_for_approval: 'bg-attention',
                    waiting_for_input: 'bg-accent',
                    idle: 'bg-fg-subtle',
                  }[session.status] ?? 'bg-fg-subtle'
                }`}
              />
              <span
                className={`text-[11px] font-medium ${
                  {
                    working: 'text-success',
                    waiting_for_approval: 'text-attention',
                    waiting_for_input: 'text-accent',
                    idle: 'text-fg-muted',
                  }[session.status] ?? 'text-fg-muted'
                }`}
              >
                {{
                  working: 'Working',
                  waiting_for_approval: 'Approval',
                  waiting_for_input: 'Input',
                  idle: 'Idle',
                }[session.status] ?? 'Idle'}
              </span>
            </span>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2 text-fg-muted">
              <ChatCircle size={12} className="text-fg-subtle shrink-0" />
              <span>{session.messageCount} messages</span>
            </div>
            <div className="flex items-center gap-2 text-fg-muted">
              <Lightning size={12} className="text-fg-subtle shrink-0" />
              <span>{session.turnCount} turns</span>
            </div>
            <div className="flex items-center gap-2 text-fg-muted">
              <Clock size={12} className="text-fg-subtle shrink-0" />
              <span>{durationMin}m elapsed</span>
            </div>
            {session.model && (
              <div className="flex items-center gap-2 text-fg-muted">
                <Terminal size={12} className="text-fg-subtle shrink-0" />
                <span className="font-mono text-[11px]">{session.model}</span>
              </div>
            )}
          </div>
        </div>

        {/* Pending tool use */}
        {session.pendingToolUse && (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              Pending Approval
            </div>
            <div className="flex items-center gap-2 rounded-md border border-attention/30 bg-attention/10 px-3 py-2">
              <Lightning size={14} className="text-attention shrink-0" />
              <span className="text-xs font-medium text-attention">
                {session.pendingToolUse.toolName}
              </span>
            </div>
          </div>
        )}

        {/* Goal */}
        {session.goal && (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              Goal
            </div>
            <p className="text-xs text-fg-muted leading-relaxed">{session.goal}</p>
          </div>
        )}

        {/* Performance Metrics */}
        {session.performanceMetrics && <PerformanceSection metrics={session.performanceMetrics} />}
      </div>
    </div>
  );
}

function PerformanceSection({
  metrics,
}: {
  metrics: NonNullable<CliSession['performanceMetrics']>;
}) {
  const pressurePct = Math.round(metrics.contextPressure * 100);
  const cachePct = Math.round(metrics.cacheHitRatio * 100);
  const pressureColor =
    metrics.contextPressure > 0.9
      ? 'text-danger'
      : metrics.contextPressure > 0.7
        ? 'text-attention'
        : 'text-success';
  const cacheColor =
    cachePct >= 70 ? 'text-success' : cachePct >= 30 ? 'text-attention' : 'text-danger';

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        Performance
      </div>
      <div className="space-y-2.5 text-xs">
        {/* Context pressure gauge */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-fg-muted">Context Pressure</span>
            <span className={`font-mono font-medium ${pressureColor}`}>{pressurePct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-emphasis overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                metrics.contextPressure > 0.9
                  ? 'bg-danger'
                  : metrics.contextPressure > 0.7
                    ? 'bg-attention'
                    : 'bg-success'
              }`}
              style={{ width: `${Math.min(pressurePct, 100)}%` }}
            />
          </div>
        </div>

        {/* Cache efficiency */}
        <div className="flex justify-between">
          <span className="text-fg-muted">Cache Efficiency</span>
          <span className={`font-mono font-medium ${cacheColor}`}>{cachePct}%</span>
        </div>

        {/* Compaction count + event timeline */}
        <div>
          <div className="flex justify-between">
            <span className="text-fg-muted">Compactions</span>
            <span className="font-mono font-medium">
              {metrics.compactionCount}
              {metrics.lastCompactionAt && (
                <span className="text-fg-subtle ml-1">
                  ({formatTimeAgo(metrics.lastCompactionAt)})
                </span>
              )}
            </span>
          </div>
          {metrics.compactionEvents && metrics.compactionEvents.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {metrics.compactionEvents.slice(-5).map((evt, i) => (
                <div
                  key={`${evt.timestamp}-${i}`}
                  className="flex items-center gap-1.5 text-[10px]"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      evt.type === 'compact' ? 'bg-attention' : 'bg-accent'
                    }`}
                  />
                  <span className="text-fg-subtle truncate">
                    {evt.type === 'compact' ? 'Full' : 'Micro'}
                    {evt.preTokens > 0 && ` · ${Math.round(evt.preTokens / 1000)}k ctx`}
                    {evt.tokensSaved != null && evt.tokensSaved > 0 && (
                      <span className="text-success"> −{Math.round(evt.tokensSaved / 1000)}k</span>
                    )}
                    {evt.parentSessionId && (
                      <span className="text-fg-subtle"> · sub:{evt.sessionId.slice(0, 6)}</span>
                    )}
                  </span>
                  <span className="ml-auto text-fg-subtle shrink-0">
                    {formatTimeAgo(evt.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent turns token bars */}
        {metrics.recentTurns.length > 0 && (
          <div>
            <div className="text-fg-muted mb-1">Recent Turns</div>
            <div className="flex items-end gap-px h-6">
              {metrics.recentTurns.map((turn) => {
                const total = turn.inputTokens + turn.outputTokens;
                const maxTokens = Math.max(
                  ...metrics.recentTurns.map((t) => t.inputTokens + t.outputTokens),
                  1
                );
                const heightPct = Math.max((total / maxTokens) * 100, 4);
                return (
                  <div
                    key={turn.turnNumber}
                    className="flex-1 rounded-t bg-accent/60 transition-all duration-300"
                    style={{ height: `${heightPct}%` }}
                    title={`T${turn.turnNumber}: ${total.toLocaleString()} tokens`}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function TokensTab({ session }: { session: CliSession }) {
  const t = session.tokenUsage;
  const totalTokens = getSessionTokenTotal(session);

  const inputPct = totalTokens > 0 ? ((t?.inputTokens ?? 0) / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? ((t?.outputTokens ?? 0) / totalTokens) * 100 : 0;
  const cachePct =
    totalTokens > 0
      ? (((t?.cacheReadTokens ?? 0) + (t?.cacheCreationTokens ?? 0)) / totalTokens) * 100
      : 0;

  return (
    <div className="overflow-y-auto p-3">
      <div className="space-y-4">
        {/* Stacked color bar */}
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            Token Distribution
          </div>
          <div className="h-3 w-full rounded-full bg-emphasis overflow-hidden">
            <div className="flex h-full">
              <div
                className="h-full bg-accent transition-all duration-500"
                style={{ width: `${inputPct}%` }}
              />
              <div
                className="h-full bg-[#a371f7] transition-all duration-500"
                style={{ width: `${outputPct}%` }}
              />
              <div
                className="h-full bg-success transition-all duration-500"
                style={{ width: `${cachePct}%` }}
              />
            </div>
          </div>
          {/* Legend */}
          <div className="flex gap-4 mt-2">
            <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
              <span className="h-2 w-2 rounded-full bg-accent" />
              Input
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
              <span className="h-2 w-2 rounded-full bg-[#a371f7]" />
              Output
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
              <span className="h-2 w-2 rounded-full bg-success" />
              Cache
            </span>
          </div>
        </div>

        {/* Breakdown */}
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            Breakdown
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="flex items-center gap-1.5 text-fg-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Input tokens
              </span>
              <span className="font-mono font-medium">
                {(t?.inputTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-1.5 text-fg-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-[#a371f7]" />
                Output tokens
              </span>
              <span className="font-mono font-medium">
                {(t?.outputTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-1.5 text-fg-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                Cache read
              </span>
              <span className="font-mono font-medium">
                {(t?.cacheReadTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-1.5 text-fg-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success/50" />
                Cache creation
              </span>
              <span className="font-mono font-medium">
                {(t?.cacheCreationTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 mt-2">
              <span className="font-semibold text-fg">Total</span>
              <span className="font-mono font-bold">{formatTokenCount(totalTokens)}</span>
            </div>
          </div>
        </div>

        {/* Cost estimate */}
        <div className="rounded-lg border border-border bg-subtle p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">
            Estimated Cost
          </div>
          <span className="text-xl font-bold text-attention tabular-nums">
            ${estimateCost(totalTokens).toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
