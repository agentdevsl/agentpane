import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  Clock,
  Copy,
  FastForward,
  File,
  Hexagon,
  Info,
  Pulse,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';

// ===== Types =====

export interface AgentError {
  code: string;
  type: string;
  message: string;
  location?: {
    file: string;
    line: number;
    column?: number;
  };
  stackTrace?: string;
  timestamp?: Date;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  type: 'read' | 'edit' | 'bash' | 'result' | 'stdout' | 'stderr' | 'error';
  message: string;
  details?: unknown;
}

export interface RetryOptions {
  feedback?: string;
  fromCheckpoint: boolean;
  increaseTurns: boolean;
  useStrongerModel: boolean;
}

export interface ErrorStateProps {
  /** Error title (defaults to "Something went wrong") */
  title?: string;
  /** Error description */
  description?: string;
  /** Detailed error information */
  error?: AgentError;
  /** Activity log entries before failure */
  activityLog?: ActivityLogEntry[];
  /** Task information for the banner */
  taskInfo?: {
    id: string;
    title: string;
    turn?: number;
    maxTurns?: number;
    duration?: string;
  };
  /** Show full error view with banner, details, and retry options */
  variant?: 'simple' | 'full';
  /** Callback for retry action */
  onRetry?: (options?: RetryOptions) => void;
  /** Callback for skip action */
  onSkip?: () => void;
  /** Callback for abort action */
  onAbort?: () => void;
  /** Callback for viewing full logs */
  onViewLogs?: () => void;
  /** Additional CSS classes */
  className?: string;
}

// ===== Log Type Styling =====

const logTypeBadgeVariants = cva(
  'flex-shrink-0 w-16 px-1.5 py-0.5 rounded text-center text-xs font-medium font-mono',
  {
    variants: {
      type: {
        read: 'bg-accent-muted text-accent-fg',
        edit: 'bg-done-muted text-done-fg',
        bash: 'bg-success-muted text-success-fg',
        result: 'bg-success-muted text-success-fg',
        stdout: 'bg-bg-muted text-fg-muted',
        stderr: 'bg-attention-muted text-attention-fg',
        error: 'bg-danger-muted text-danger-fg',
      },
    },
    defaultVariants: {
      type: 'stdout',
    },
  }
);

// ===== Sub-Components =====

function ErrorBanner({ taskInfo }: { taskInfo?: ErrorStateProps['taskInfo'] }) {
  return (
    <div
      className="relative overflow-hidden border-b border-danger-fg"
      style={{
        background: 'linear-gradient(135deg, var(--danger-emphasis) 0%, #8b1a1a 100%)',
      }}
    >
      <div className="max-w-5xl mx-auto px-8 py-6">
        <div className="flex items-start gap-6">
          {/* Error icon */}
          <div className="flex-shrink-0 w-12 h-12 rounded-full bg-black/30 flex items-center justify-center">
            <XCircle className="w-7 h-7 text-white" weight="bold" />
          </div>

          {/* Error info */}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold text-white mb-2 flex items-center gap-2">
              Agent Failed
            </h1>

            {taskInfo && (
              <div className="flex flex-wrap gap-6 text-white/85 text-sm">
                {taskInfo.id && (
                  <div className="flex items-center gap-1.5">
                    <File className="w-4 h-4 opacity-70" />
                    <span className="font-mono text-xs bg-black/30 px-2 py-0.5 rounded">
                      {taskInfo.id}
                    </span>
                    {taskInfo.title && (
                      <span className="truncate max-w-64">"{taskInfo.title}"</span>
                    )}
                  </div>
                )}
                {taskInfo.turn !== undefined && taskInfo.maxTurns !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <Pulse className="w-4 h-4 opacity-70" />
                    <span>
                      Failed at: Turn {taskInfo.turn} of {taskInfo.maxTurns}
                    </span>
                  </div>
                )}
                {taskInfo.duration && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4 opacity-70" />
                    <span>Duration: {taskInfo.duration}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorDetailsCard({ error }: { error: AgentError }) {
  return (
    <div className="rounded-lg border border-danger-fg border-l-[3px] bg-bg-default overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-bg-subtle flex items-center gap-2">
        <Info className="w-4 h-4 text-fg-muted" />
        <span className="text-sm font-semibold text-fg">Error Details</span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* Error type badge */}
        <span className="inline-flex items-center gap-1.5 bg-danger-muted text-danger-fg px-3 py-1 rounded-full text-xs font-semibold font-mono">
          <Hexagon className="w-3 h-3" weight="fill" />
          {error.type || error.code}
        </span>

        {/* Error message */}
        <div className="p-4 bg-bg-subtle rounded-md border-l-[3px] border-danger-fg">
          <p className="text-base font-medium text-fg">{error.message}</p>
        </div>

        {/* Error location */}
        {error.location && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <File className="w-4 h-4" />
            <span>Error location:</span>
            <code className="font-mono text-accent-fg bg-bg-muted px-2 py-0.5 rounded">
              {error.location.file}:{error.location.line}
              {error.location.column !== undefined && `:${error.location.column}`}
            </code>
          </div>
        )}
      </div>
    </div>
  );
}

function StackTracePanel({ stackTrace, onCopy }: { stackTrace: string; onCopy?: () => void }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(stackTrace);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    onCopy?.();
  };

  // Basic syntax highlighting for stack traces
  const highlightedTrace = useMemo(
    () =>
      stackTrace.split('\n').map((line, index) => {
        const key = `${line}-${index}`;
        // Error line (first line or lines with Error:)
        if (index === 0 || line.includes('Error:')) {
          return (
            <span key={key} className="text-danger-fg">
              {line}
              {'\n'}
            </span>
          );
        }

        // File paths and line numbers
        const fileMatch = line.match(/(\S+\.(ts|js|tsx|jsx|mjs|cjs))(:(\d+))?/);
        if (fileMatch) {
          const parts = line.split(fileMatch[0]);
          return (
            <span key={key}>
              {parts[0]}
              <span className="text-accent-fg">{fileMatch[1]}</span>
              {fileMatch[3] && (
                <>
                  :<span className="text-attention-fg">{fileMatch[4]}</span>
                </>
              )}
              {parts[1]}
              {'\n'}
            </span>
          );
        }

        return (
          <span key={key}>
            {line}
            {'\n'}
          </span>
        );
      }),
    [stackTrace]
  );

  return (
    <div className="rounded-lg border border-border bg-bg-default overflow-hidden">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 border-b border-border bg-bg-subtle flex items-center justify-between hover:bg-bg-muted transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          {isExpanded ? (
            <CaretDown className="w-4 h-4 text-fg-muted" />
          ) : (
            <CaretRight className="w-4 h-4 text-fg-muted" />
          )}
          Stack Trace
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-muted border border-border rounded text-xs text-fg-muted hover:text-fg hover:bg-bg-emphasis transition-colors"
        >
          <Copy className="w-3.5 h-3.5" />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </button>

      {/* Stack trace content */}
      {isExpanded && (
        <div className="m-4 rounded border border-border bg-bg-canvas overflow-x-auto">
          <pre className="p-4 font-mono text-xs leading-relaxed text-fg whitespace-pre-wrap">
            {highlightedTrace}
          </pre>
        </div>
      )}
    </div>
  );
}

function ActivityLog({ entries }: { entries: ActivityLogEntry[] }) {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="rounded-lg border border-border bg-bg-default overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-bg-subtle flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          <File className="w-4 h-4 text-fg-muted" />
          Activity Log Before Failure
        </span>
        <span className="text-xs text-fg-subtle">Last {entries.length} entries</span>
      </div>

      {/* Log entries */}
      <div className="max-h-96 overflow-y-auto">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={cn(
              'flex items-start gap-2 px-4 py-2 border-b border-border font-mono text-xs hover:bg-bg-subtle transition-colors',
              entry.type === 'error' && 'bg-danger-muted'
            )}
          >
            <span className="flex-shrink-0 w-16 text-fg-subtle">{formatTime(entry.timestamp)}</span>
            <span className={logTypeBadgeVariants({ type: entry.type })}>{entry.type}</span>
            <span
              className={cn(
                'flex-1 truncate',
                entry.type === 'error' ? 'text-danger-fg' : 'text-fg',
                entry.type === 'result' && entry.message.includes('✓') && 'text-success-fg'
              )}
            >
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RetryOptionsPanel({ onRetry }: { onRetry: (options: RetryOptions) => void }) {
  const [feedback, setFeedback] = useState('');
  const [fromCheckpoint, setFromCheckpoint] = useState(true);
  const [increaseTurns, setIncreaseTurns] = useState(false);
  const [useStrongerModel, setUseStrongerModel] = useState(false);

  const handleRetry = () => {
    onRetry({
      feedback: feedback || undefined,
      fromCheckpoint,
      increaseTurns,
      useStrongerModel,
    });
  };

  return (
    <div className="rounded-lg border border-accent-fg bg-bg-default overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-bg-subtle flex items-center gap-2">
        <ArrowCounterClockwise className="w-4 h-4 text-fg-muted" />
        <span className="text-sm font-semibold text-fg">Retry Options</span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* Feedback textarea */}
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={`Provide additional context for retry...\n\nExample: The user_id field should be coerced to string before validation, or the schema should accept both string and number types.`}
          className="w-full min-h-24 p-3 bg-bg-subtle border border-border rounded-md text-sm text-fg placeholder:text-fg-subtle resize-y focus:outline-none focus:border-accent-fg focus:ring-2 focus:ring-accent-muted"
        />

        {/* Checkbox options */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer hover:text-fg transition-colors">
            <input
              type="checkbox"
              checked={fromCheckpoint}
              onChange={(e) => setFromCheckpoint(e.target.checked)}
              className="w-4 h-4 rounded border-border bg-bg-subtle accent-accent-fg"
            />
            Start from last successful checkpoint
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer hover:text-fg transition-colors">
            <input
              type="checkbox"
              checked={increaseTurns}
              onChange={(e) => setIncreaseTurns(e.target.checked)}
              className="w-4 h-4 rounded border-border bg-bg-subtle accent-accent-fg"
            />
            Increase max turns limit
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer hover:text-fg transition-colors">
            <input
              type="checkbox"
              checked={useStrongerModel}
              onChange={(e) => setUseStrongerModel(e.target.checked)}
              className="w-4 h-4 rounded border-border bg-bg-subtle accent-accent-fg"
            />
            Use more capable model (claude-opus)
          </label>
        </div>

        {/* Retry button */}
        <Button onClick={handleRetry} className="w-full">
          <ArrowCounterClockwise className="w-4 h-4" />
          Retry Task
        </Button>
      </div>
    </div>
  );
}

function ActionButtonsPanel({
  onSkip,
  onAbort,
  onViewLogs,
}: {
  onSkip?: () => void;
  onAbort?: () => void;
  onViewLogs?: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-default overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-bg-subtle flex items-center gap-2">
        <span className="text-sm font-semibold text-fg">Actions</span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-2">
        {onSkip && (
          <Button
            variant="outline"
            onClick={onSkip}
            className="w-full border-attention-fg text-attention-fg hover:bg-attention-muted"
          >
            <FastForward className="w-4 h-4" />
            Skip Task
          </Button>
        )}
        {onAbort && (
          <Button variant="destructive" onClick={onAbort} className="w-full">
            <X className="w-4 h-4" />
            Abort & Return to Queue
          </Button>
        )}
        {onViewLogs && (
          <button
            type="button"
            onClick={onViewLogs}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-accent-fg hover:underline transition-colors"
          >
            <File className="w-3.5 h-3.5" />
            View Full Logs
          </button>
        )}
      </div>
    </div>
  );
}

// ===== Main Component =====

export function ErrorState({
  title = 'Something went wrong',
  description = 'Try again or check your connection.',
  error,
  activityLog,
  taskInfo,
  variant = 'simple',
  onRetry,
  onSkip,
  onAbort,
  onViewLogs,
  className,
}: ErrorStateProps): React.JSX.Element {
  // Simple variant - compact error display
  if (variant === 'simple') {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-bg-default p-6 text-center',
          className
        )}
        data-testid="error-state"
      >
        <div
          className="rounded-full border border-border bg-bg-subtle p-3"
          data-testid="error-state-icon"
        >
          <WarningCircle className="h-6 w-6 text-danger-fg" weight="fill" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-fg" data-testid="error-state-title">
            {title}
          </h3>
          <p className="text-xs text-fg-muted" data-testid="error-state-description">
            {description}
          </p>
        </div>
        {onRetry && (
          <Button variant="outline" onClick={() => onRetry()} data-testid="retry-button">
            Retry
          </Button>
        )}
      </div>
    );
  }

  // Full variant - detailed error view with all panels
  return (
    <div role="alert" className={cn('min-h-screen bg-bg-canvas', className)}>
      {/* Error banner */}
      <ErrorBanner taskInfo={taskInfo} />

      {/* Main content */}
      <div className="max-w-5xl mx-auto p-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* Primary column */}
          <div className="space-y-6">
            {/* Error details card */}
            {error && <ErrorDetailsCard error={error} />}

            {/* Stack trace */}
            {error?.stackTrace && <StackTracePanel stackTrace={error.stackTrace} />}

            {/* Activity log */}
            {activityLog && activityLog.length > 0 && <ActivityLog entries={activityLog} />}
          </div>

          {/* Secondary column */}
          <div className="space-y-6">
            {/* Retry options */}
            {onRetry && <RetryOptionsPanel onRetry={onRetry} />}

            {/* Action buttons */}
            {(onSkip || onAbort || onViewLogs) && (
              <ActionButtonsPanel onSkip={onSkip} onAbort={onAbort} onViewLogs={onViewLogs} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
