import { FolderOpen, Terminal } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardsRightPanel } from '@/app/components/features/cli-monitor/cards-right-panel';
import { useCliMonitor } from '@/app/components/features/cli-monitor/cli-monitor-context';
import type {
  AlertToast,
  CliSession,
} from '@/app/components/features/cli-monitor/cli-monitor-types';
import {
  formatTokenCount,
  getSessionTokenTotal,
} from '@/app/components/features/cli-monitor/cli-monitor-utils';
import { SummaryStrip } from '@/app/components/features/cli-monitor/summary-strip';

// -- Constants --

const VISIBLE_SESSION_LIMIT = 50;

// -- Route --

export const Route = createFileRoute('/cli-monitor/')({
  component: CliMonitorCardsView,
});

// -- Main Page Component --

function CliMonitorCardsView(): React.JSX.Element {
  const { pageState, sessions, alerts, dismissAlert } = useCliMonitor();

  return (
    <>
      {pageState === 'install' && <InstallState />}
      {pageState === 'waiting' && <WaitingState />}
      {pageState === 'active' && (
        <ActiveState sessions={sessions} alerts={alerts} onDismissAlert={dismissAlert} />
      )}
    </>
  );
}

// -- Install State --

function InstallState() {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText('npx @agentpane/cli-monitor');
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/10">
        <Terminal
          size={40}
          className="text-accent"
          style={{ filter: 'drop-shadow(0 0 12px rgba(88,166,255,0.4))' }}
        />
      </div>

      <h2 className="text-xl font-bold tracking-tight">Monitor your Claude Code sessions</h2>
      <p className="max-w-[400px] text-sm leading-relaxed text-fg-muted">
        See all your CLI sessions across projects in one place. Bring your own agent, centralised
        visibility.
      </p>

      <div className="w-full max-w-[480px]">
        <div className="mb-2 text-left text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
          Install
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied!' : 'Copy install command'}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-accent bg-default dark:bg-[#0a0e14] px-5 py-4 font-mono text-[15px] text-success shadow-[0_0_20px_rgba(88,166,255,0.1)] transition-all hover:-translate-y-0.5 hover:border-[#79b8ff] hover:shadow-[0_0_30px_rgba(88,166,255,0.2)]"
        >
          <span className="text-fg-subtle">$</span>
          <span className="flex-1 text-left">npx @agentpane/cli-monitor</span>
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-all ${
              copied
                ? 'bg-success/15 text-success'
                : 'bg-emphasis text-fg-muted hover:bg-accent/15 hover:text-accent'
            }`}
          >
            {copied ? '\u2713' : '\u29C9'}
          </div>
        </button>
      </div>

      <div className="flex w-full max-w-[480px] flex-col gap-2 text-left text-sm text-fg-muted">
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle">{'\uD83D\uDC41'}</span>
          Watches{' '}
          <code className="rounded bg-accent/15 px-1 py-0.5 font-mono text-xs text-accent">
            ~/.claude/projects/
          </code>{' '}
          for session logs
        </div>
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle">{'\uD83D\uDD12'}</span>
          Runs locally &mdash; no data leaves your machine
        </div>
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle">{'\u23FB'}</span>
          Stop anytime:{' '}
          <code className="rounded bg-accent/15 px-1 py-0.5 font-mono text-xs text-accent">
            cli-monitor stop
          </code>
        </div>
      </div>

      <div className="w-full max-w-[480px] text-left">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
          Or install globally
        </div>
        <div className="space-y-2 text-sm text-fg-muted">
          <div className="flex items-center gap-2">
            <code className="rounded bg-accent/15 px-2 py-1 font-mono text-xs text-accent">
              npm i -g @agentpane/cli-monitor
            </code>
          </div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-accent/15 px-2 py-1 font-mono text-xs text-accent">
              brew install agentpane/tap/cli-monitor
            </code>
          </div>
        </div>
      </div>

      <div className="w-full max-w-[400px] opacity-30 transition-opacity hover:opacity-50">
        <div className="relative h-[84px] overflow-hidden rounded-md border border-border bg-default">
          <div className="absolute top-3 left-[10%] h-4 w-[45%] rounded bg-accent/10 border border-accent/15" />
          <div className="absolute top-[34px] left-[25%] h-4 w-[55%] rounded bg-accent/10 border border-accent/15" />
          <div className="absolute top-[56px] left-[5%] h-4 w-[35%] rounded bg-accent/10 border border-accent/15" />
        </div>
      </div>
    </div>
  );
}

// -- Waiting State --

function WaitingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="relative mb-4 h-20 w-20">
        <div
          className="absolute inset-0 animate-ping rounded-full border border-success opacity-20"
          style={{ animationDuration: '3s' }}
        />
        <div
          className="absolute inset-0 animate-ping rounded-full border border-success opacity-20"
          style={{ animationDuration: '3s', animationDelay: '1s' }}
        />
        <div
          className="absolute inset-0 animate-ping rounded-full border border-success opacity-20"
          style={{ animationDuration: '3s', animationDelay: '2s' }}
        />
        <div
          className="absolute top-1/2 left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-success shadow-[0_0_12px_rgba(63,185,80,0.4)]"
          style={{ animation: 'pulse 2s ease-in-out infinite' }}
        />
      </div>

      <h2 className="text-lg font-semibold">Watching for sessions...</h2>
      <p className="max-w-[360px] text-sm text-fg-muted">
        Start a Claude Code session in any terminal to see it here
      </p>

      <div className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
        Try running
      </div>
      <div className="inline-flex items-center gap-2 rounded-md border border-border bg-default dark:bg-[#0a0e14] px-4 py-3 font-mono text-sm text-success">
        <span className="text-fg-subtle">$</span>
        claude &quot;fix the auth bug&quot;
        <span className="inline-block h-3.5 w-2 animate-pulse bg-accent" />
      </div>
      <span className="text-xs italic text-fg-subtle">
        or simply{' '}
        <code className="rounded bg-accent/15 px-1 py-0.5 font-mono text-accent">claude</code> for
        interactive
      </span>
    </div>
  );
}

// -- Active State --

function ActiveState({
  sessions,
  alerts,
  onDismissAlert,
}: {
  sessions: CliSession[];
  alerts: AlertToast[];
  onDismissAlert: (id: string) => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_SESSION_LIMIT);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId);

  useEffect(() => {
    if (selectedSessionId && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedSessionId(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedSessionId]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisibleCount((prev) => prev + VISIBLE_SESSION_LIMIT);
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const flatSessions = useMemo(() => sessions.filter((s) => !s.isSubagent), [sessions]);

  useEffect(() => {
    const el = sessionListRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, flatSessions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < flatSessions.length) {
        e.preventDefault();
        const session = flatSessions[focusedIndex];
        if (session) {
          setSelectedSessionId(session.sessionId === selectedSessionId ? null : session.sessionId);
        }
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [flatSessions, focusedIndex, selectedSessionId]);

  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = sessionListRef.current?.querySelector(`[data-session-index="${focusedIndex}"]`);
    if (el) {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  const projectGroups = useMemo(() => {
    const groups = new Map<string, CliSession[]>();
    for (const s of flatSessions) {
      const key = s.projectName || 'Unknown';
      const arr = groups.get(key) || [];
      arr.push(s);
      groups.set(key, arr);
    }
    return groups;
  }, [flatSessions]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Alert Toasts */}
      {alerts.length > 0 && (
        <output className="flex flex-col items-center gap-2 px-6 py-2" aria-live="polite">
          {alerts.slice(0, 3).map((alert) => (
            <AlertToastItem
              key={alert.id}
              alert={alert}
              onDismiss={() => onDismissAlert(alert.id)}
            />
          ))}
          {alerts.length > 3 && (
            <span className="text-xs text-fg-subtle">+{alerts.length - 3} more</span>
          )}
        </output>
      )}

      {/* Summary Strip */}
      <SummaryStrip sessions={sessions} />

      {/* Two-column layout */}
      <div
        className={`flex-1 overflow-hidden ${selectedSession ? 'grid grid-cols-[1fr_380px]' : ''}`}
      >
        {/* Left: Session List */}
        <div
          ref={sessionListRef}
          className="overflow-y-auto p-4"
          role="listbox"
          aria-label="CLI sessions"
          tabIndex={0}
        >
          <div className="space-y-6">
            {(() => {
              let rendered = 0;
              const groups = Array.from(projectGroups.entries());
              return groups.map(([projectName, projectSessions]) => {
                if (rendered >= visibleCount) return null;
                const remainingSlots = visibleCount - rendered;
                const visibleProjectSessions = projectSessions.slice(0, remainingSlots);
                const startIdx = rendered;
                rendered += visibleProjectSessions.length;
                const firstSession = projectSessions[0];
                return (
                  <div key={projectName}>
                    {/* Project Group Header */}
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
                      <FolderOpen size={16} className="text-fg-subtle shrink-0" />
                      <span className="text-sm font-semibold text-fg">{projectName}</span>
                      {firstSession?.cwd && (
                        <span className="font-mono text-[11px] text-fg-subtle truncate">
                          {firstSession.cwd}
                        </span>
                      )}
                      <span className="ml-auto rounded-full bg-emphasis px-2 py-0.5 text-[11px] font-medium text-fg-muted">
                        {projectSessions.length}
                      </span>
                    </div>
                    {/* Session Cards Grid */}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                      {visibleProjectSessions.map((session, i) => (
                        <SessionCard
                          key={session.sessionId}
                          session={session}
                          selected={session.sessionId === selectedSessionId}
                          focused={startIdx + i === focusedIndex}
                          dataIndex={startIdx + i}
                          onClick={() =>
                            setSelectedSessionId(
                              session.sessionId === selectedSessionId ? null : session.sessionId
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
            {flatSessions.length > visibleCount && (
              <div ref={loadMoreRef} className="py-2 text-center text-xs text-fg-subtle">
                Showing {visibleCount} of {flatSessions.length} sessions &mdash; scroll to load more
              </div>
            )}
          </div>
        </div>

        {/* Right: Detail Panel */}
        {selectedSession && (
          <CardsRightPanel session={selectedSession} onClose={() => setSelectedSessionId(null)} />
        )}
      </div>
    </div>
  );
}

// -- Alert Toast --

function AlertToastItem({ alert, onDismiss }: { alert: AlertToast; onDismiss: () => void }) {
  const borderColor = {
    approval: 'border-l-attention',
    input: 'border-l-accent',
    complete: 'border-l-success',
    error: 'border-l-danger',
    'new-session': 'border-l-fg-subtle',
  }[alert.type];

  return (
    <div
      className={`flex w-full max-w-[560px] items-center gap-3 rounded-md border border-border ${borderColor} border-l-4 bg-default px-4 py-2.5 shadow-md animate-in slide-in-from-top-2`}
    >
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-semibold">{alert.title}</span>
        <span className="truncate font-mono text-xs text-fg-muted">{alert.detail}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss alert"
        className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-emphasis hover:text-fg"
      >
        {'\u2715'}
      </button>
    </div>
  );
}

// -- Session Card --

const statusAccentBorder: Record<string, string> = {
  working: 'border-l-success',
  waiting_for_approval: 'border-l-attention',
  waiting_for_input: 'border-l-accent',
  idle: 'border-l-fg-subtle',
};

const statusBadgeConfig: Record<string, { text: string; badge: string }> = {
  working: { text: 'Working', badge: 'bg-success/15 text-success' },
  waiting_for_approval: { text: 'Approval', badge: 'bg-attention/15 text-attention' },
  waiting_for_input: { text: 'Input', badge: 'bg-accent/15 text-accent' },
  idle: { text: 'Idle', badge: 'bg-emphasis text-fg-muted' },
};

function SessionCard({
  session,
  selected,
  focused,
  dataIndex,
  onClick,
}: {
  session: CliSession;
  selected: boolean;
  focused?: boolean;
  dataIndex?: number;
  onClick: () => void;
}) {
  const accentBorder = statusAccentBorder[session.status] ?? 'border-l-fg-subtle';
  const config = statusBadgeConfig[session.status] ?? {
    text: 'Idle',
    badge: 'bg-emphasis text-fg-muted',
  };
  const totalTokens = getSessionTokenTotal(session);
  const isWorking = session.status === 'working';

  const timeAgo = useMemo(() => {
    const ms = Date.now() - session.lastActivityAt;
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  }, [session.lastActivityAt]);

  return (
    <button
      type="button"
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={`Session: ${session.goal || session.sessionId.slice(0, 8)}`}
      data-session-index={dataIndex}
      className={`group/card flex w-full flex-col rounded-lg border border-l-[3px] text-left transition-all ${accentBorder} ${
        selected
          ? 'border-accent bg-accent/5 shadow-md border-l-accent'
          : focused
            ? 'border-border bg-subtle ring-2 ring-accent/30'
            : 'border-border bg-default hover:border-fg-subtle hover:bg-subtle'
      } ${isWorking ? 'shadow-[0_0_12px_rgba(63,185,80,0.08)]' : ''}`}
    >
      {/* Card Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <span className="font-mono text-[11px] text-fg-subtle">
          {session.sessionId.slice(0, 8)}
        </span>
        {session.gitBranch && (
          <span className="rounded bg-[#a371f7]/15 px-1.5 py-0.5 text-[10px] font-mono font-medium text-[#a371f7] truncate max-w-[140px]">
            {session.gitBranch}
          </span>
        )}
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold ${config.badge}`}>
          {config.text}
        </span>
        <HealthBadge session={session} />
      </div>

      {/* Card Body - Goal */}
      <div className="px-3 py-1.5">
        <p className="text-[13px] font-medium text-fg line-clamp-2 leading-snug">
          {session.goal || 'Interactive session'}
        </p>
      </div>

      {/* Output Preview */}
      {session.recentOutput && (
        <div className="mx-3 mb-2 relative">
          <div className="rounded bg-subtle dark:bg-[#0a0e14]/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-fg-muted max-h-[56px] overflow-hidden">
            {(() => {
              const trimmed = session.recentOutput.trimStart();
              const looksLikeJson =
                trimmed.startsWith('"') || trimmed.startsWith('{') || trimmed.startsWith('[');
              if (looksLikeJson) {
                return session.goal || 'Processing...';
              }
              return session.recentOutput.split('\n').slice(-3).join('\n');
            })()}
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-subtle dark:from-[#0a0e14]/60 to-transparent rounded-b pointer-events-none" />
        </div>
      )}

      {/* Pending tool badge */}
      {session.pendingToolUse && (
        <div className="mx-3 mb-2">
          <span className="inline-flex items-center gap-1.5 rounded bg-attention/15 px-2 py-1 text-[11px] font-medium text-attention">
            <span className="h-1.5 w-1.5 rounded-full bg-attention" />
            {session.pendingToolUse.toolName}
          </span>
        </div>
      )}

      {/* Card Footer */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-2 mt-auto">
        <span className="text-[11px] text-fg-subtle">{session.messageCount} msgs</span>
        <span className="text-[11px] text-fg-subtle">{timeAgo}</span>
        {(session.performanceMetrics?.compactionCount ?? 0) > 0 && (
          <span className="text-[10px] text-attention font-mono">
            {session.performanceMetrics?.compactionCount} compaction
            {session.performanceMetrics?.compactionCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-fg-muted">
          {formatTokenCount(totalTokens)}
        </span>
      </div>
      {/* Context pressure mini-bar */}
      <ContextPressureBar session={session} />
    </button>
  );
}

// -- Health Badge --

function HealthBadge({ session }: { session: CliSession }) {
  const health = session.performanceMetrics?.healthStatus;
  if (!health || health === 'healthy') return null;

  const pm = session.performanceMetrics;
  const pressurePct = pm ? Math.round(pm.contextPressure * 100) : 0;
  const tooltip =
    health === 'critical'
      ? `Context pressure: ${pressurePct}%`
      : pm && pm.compactionCount > 0
        ? `${pm.compactionCount} compaction${pm.compactionCount > 1 ? 's' : ''} detected`
        : `Context pressure: ${pressurePct}%`;

  if (health === 'critical') {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" title={tooltip}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
      </span>
    );
  }

  return (
    <span className="inline-flex h-2.5 w-2.5 rounded-full bg-attention shrink-0" title={tooltip} />
  );
}

// -- Context Pressure Mini-bar --

function ContextPressureBar({ session }: { session: CliSession }) {
  const pressure = session.performanceMetrics?.contextPressure ?? 0;
  if (pressure <= 0) return null;

  const pct = Math.min(pressure * 100, 100);
  const barColor = pressure > 0.9 ? 'bg-danger' : pressure > 0.7 ? 'bg-attention' : 'bg-success';

  return (
    <div className="h-[2px] w-full bg-emphasis rounded-b-lg overflow-hidden">
      <div
        className={`h-full ${barColor} transition-all duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
