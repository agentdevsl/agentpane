import { ArrowsIn, ArrowsOut, GitBranch, Terminal } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { CliSession } from './cli-monitor-types';

const statusDotClass: Record<string, string> = {
  working: 'bg-success animate-pulse',
  waiting_for_approval: 'bg-attention',
  waiting_for_input: 'bg-accent animate-pulse',
  idle: 'bg-fg-subtle',
};

const statusBarColor: Record<string, string> = {
  working: 'bg-success',
  waiting_for_approval: 'bg-attention',
  waiting_for_input: 'bg-accent',
  idle: 'bg-fg-subtle',
};

const paneStateClass: Record<string, string> = {
  working: 'border-success/30 animate-[glowBorder_3s_ease-in-out_infinite]',
  waiting_for_approval: 'border-attention/25',
  waiting_for_input: 'border-accent/25',
  idle: 'opacity-55 hover:opacity-80',
};

interface TerminalPaneProps {
  session: CliSession | null;
  paneIndex: number;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}

export function TerminalPane({
  session,
  paneIndex,
  maximized,
  onToggleMaximize,
}: TerminalPaneProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);

  // Auto-scroll to bottom when content updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: recentOutput triggers scroll
  useEffect(() => {
    if (!contentRef.current || !isPinnedRef.current) return;
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [session?.recentOutput]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    isPinnedRef.current = atBottom;
  };

  if (!session) {
    return (
      <div className="flex flex-col bg-[#0a0e14] border border-transparent">
        <div className="flex items-center justify-between px-3 py-1 bg-default border-b border-border min-h-[32px]">
          <span className="font-mono text-[11px] text-fg-subtle">Pane {paneIndex + 1}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
          <Terminal size={24} className="text-fg-subtle" />
          <span className="text-fg-subtle text-[11px]">Click to assign</span>
        </div>
      </div>
    );
  }

  const healthStatus = session.performanceMetrics?.healthStatus;
  const healthBorderClass =
    healthStatus === 'critical'
      ? 'ring-1 ring-danger/40'
      : healthStatus === 'warning'
        ? 'ring-1 ring-attention/30'
        : '';
  const stateClass = paneStateClass[session.status] ?? '';
  const isWorking = session.status === 'working';

  const compactionCount = session.performanceMetrics?.compactionCount ?? 0;

  return (
    <div
      className={`flex flex-col bg-[#0a0e14] border transition-all ${stateClass} ${healthBorderClass}`}
    >
      {/* Status color bar */}
      <div className={`h-[2px] shrink-0 ${statusBarColor[session.status] ?? 'bg-fg-subtle'}`} />

      {/* Tab bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-default border-b border-border min-h-[32px] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-[7px] w-[7px] rounded-full shrink-0 ${statusDotClass[session.status] ?? 'bg-fg-subtle'}`}
          />
          <span className="font-mono text-[11px] font-semibold text-fg">
            {session.sessionId.slice(0, 7)}
          </span>
          {session.gitBranch && (
            <span className="flex items-center gap-1 rounded bg-[#a371f7]/15 px-1.5 py-px text-[10px] font-mono font-medium text-[#a371f7] max-w-[140px] truncate">
              <GitBranch size={10} className="shrink-0" />
              {session.gitBranch}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-fg-subtle font-medium">{session.projectName}</span>
          <span className="text-[10px] font-mono text-fg-subtle">T{session.turnCount}</span>
          {session.performanceMetrics && (
            <>
              <CtxLabel pressure={session.performanceMetrics.contextPressure} />
              <ChrLabel ratio={session.performanceMetrics.cacheHitRatio} />
              {compactionCount > 0 && (
                <span
                  className="text-[10px] font-mono font-medium text-attention"
                  title="Compaction count"
                >
                  C{compactionCount}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize?.();
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity group-hover/pane:opacity-100 hover:bg-subtle hover:text-fg"
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <ArrowsIn size={12} /> : <ArrowsOut size={12} />}
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 px-3 font-mono text-[11px] leading-[1.7] text-fg-muted"
      >
        {session.recentOutput ? (
          <TerminalOutput output={session.recentOutput} isWorking={isWorking} />
        ) : (
          <div className="text-fg-subtle italic">No output yet...</div>
        )}
      </div>
    </div>
  );
}

function TerminalOutput({ output, isWorking }: { output: string; isWorking: boolean }) {
  const lines = output.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <TerminalLine key={i} line={line} />
      ))}
      {isWorking && (
        <span className="inline-block w-[7px] h-[13px] bg-[#a371f7] animate-[blink_1s_step-end_infinite] align-text-bottom ml-0.5" />
      )}
    </>
  );
}

function TerminalLine({ line }: { line: string }) {
  // Parse role prefixes
  const userMatch = line.match(/^\[user\](.*)/);
  if (userMatch) {
    return (
      <div className="mb-px animate-[fadeInLine_0.2s_ease]">
        <span className="text-accent font-semibold">[user]</span>
        <span className="text-fg-muted">{userMatch[1]}</span>
      </div>
    );
  }

  const claudeMatch = line.match(/^\[claude\](.*)/);
  if (claudeMatch) {
    return (
      <div className="mb-px animate-[fadeInLine_0.2s_ease]">
        <span className="text-[#a371f7] font-semibold">[claude]</span>
        <span className="text-fg-muted">{claudeMatch[1]}</span>
      </div>
    );
  }

  const toolMatch = line.match(/^\[tool:([^\]]+)\](.*)/);
  if (toolMatch) {
    return (
      <div className="mb-px animate-[fadeInLine_0.2s_ease] bg-attention/[0.06] border-l-2 border-attention pl-2 py-px my-0.5">
        <span className="text-attention font-semibold">[tool:{toolMatch[1]}]</span>
        <span className="text-fg-muted">{toolMatch[2]}</span>
      </div>
    );
  }

  const systemMatch = line.match(/^\[system\](.*)/);
  if (systemMatch) {
    return (
      <div className="mb-px animate-[fadeInLine_0.2s_ease]">
        <span className="text-fg-subtle font-medium">[system]</span>
        <span className="text-fg-subtle">{systemMatch[1]}</span>
      </div>
    );
  }

  return (
    <div className="mb-px animate-[fadeInLine_0.2s_ease] whitespace-pre-wrap break-words text-fg-muted">
      {line}
    </div>
  );
}

function CtxLabel({ pressure }: { pressure: number }) {
  const pct = Math.round(pressure * 100);
  const color =
    pressure > 0.9 ? 'text-danger' : pressure > 0.7 ? 'text-attention' : 'text-fg-subtle';
  const bgClass = pressure > 0.9 ? 'bg-danger/15' : pressure > 0.7 ? 'bg-attention/15' : '';
  return (
    <span
      className={`text-[10px] font-mono font-medium rounded px-1 ${color} ${bgClass}`}
      title="Context window pressure"
    >
      CTX {pct}%
    </span>
  );
}

function ChrLabel({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const color = pct >= 70 ? 'text-fg-subtle' : pct >= 30 ? 'text-attention' : 'text-danger';
  const bgClass = pct < 30 ? 'bg-danger/15' : pct < 70 ? 'bg-attention/15' : '';
  return (
    <span
      className={`text-[10px] font-mono font-medium rounded px-1 ${color} ${bgClass}`}
      title="Cache hit ratio"
    >
      CHR {pct}%
    </span>
  );
}
