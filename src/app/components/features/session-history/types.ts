import type { SessionStatus } from '@/db/schema';
import type { SessionEvent, SessionEventType } from '@/services/session.service';

// ===== Tool Call Types =====

/**
 * Tool call execution status
 * - running: Tool has started but no result received
 * - complete: Tool finished successfully
 * - error: Tool finished with an error
 */
export type ToolCallStatus = 'running' | 'complete' | 'error';

export interface ToolCallEntry {
  /** Unique ID for the tool call (from tool:start event) */
  readonly id: string;
  /** Tool name (e.g., "Read", "Grep", "Edit") */
  readonly tool: string;
  /** Input parameters passed to the tool */
  readonly input: Record<string, unknown> | undefined;
  /** Output result from the tool (undefined if still running) */
  readonly output?: unknown;
  /** Execution status */
  readonly status: ToolCallStatus;
  /** Execution duration in milliseconds (undefined if still running) */
  readonly duration?: number;
  /** Timestamp when tool started (Unix ms) */
  readonly timestamp: number;
  /** Formatted time offset from session start (e.g. "1:35" or "1:23:45" for times over an hour) */
  readonly timeOffset: string;
  /** Error message if status is 'error' */
  readonly error?: string;
}

export interface ToolCallStats {
  readonly totalCalls: number;
  readonly errorCount: number;
  readonly avgDurationMs: number;
  /** Total execution time across all tool calls in milliseconds */
  readonly totalDurationMs: number;
  readonly toolBreakdown: ReadonlyArray<{ readonly tool: string; readonly count: number }>;
}

// ===== Tool Call Status Colors =====

/** Text colors for tool call status - used for icon coloring */
export const TOOL_CALL_STATUS_COLORS = {
  running: { text: 'text-accent' },
  complete: { text: 'text-success' },
  error: { text: 'text-danger' },
} as const satisfies Record<ToolCallStatus, { text: string }>;

// ===== Session Filter Types =====

export interface SessionFilters {
  /** Filter by session status */
  status?: SessionStatus[];
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by task ID */
  taskId?: string;
  /** Date range start (ISO string) */
  dateFrom?: string;
  /** Date range end (ISO string) */
  dateTo?: string;
  /** Search query */
  search?: string;
}

// ===== Sort Types =====

export type SessionSortField = 'createdAt' | 'closedAt' | 'duration' | 'lastActivityAt';
export type SortDirection = 'asc' | 'desc';

export interface SessionSort {
  field: SessionSortField;
  direction: SortDirection;
}

// ===== Session List Item =====

export interface SessionListItem {
  id: string;
  title: string | null;
  agentName: string | null;
  agentId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  status: SessionStatus;
  createdAt: string;
  /**
   * Timestamp of the most recent event in this session, or `createdAt` if
   * the session has no events yet. The "Recent Sessions" UI sorts and
   * groups by this — sessions are reused across re-runs of the same task,
   * so `createdAt` no longer reflects "when did this session last do
   * something". Optional for backwards-compat with cached responses.
   */
  lastActivityAt?: string;
  closedAt: string | null;
  /** Duration in milliseconds */
  duration: number | null;
  turnsUsed: number;
  tokensUsed: number;
  /** Codespace ID this session belongs to */
  codespaceId: string;
  /** Codespace name for display */
  codespaceName: string | null;
  /** @deprecated Use codespaceId instead */
  projectId?: string;
  /** @deprecated Use codespaceName instead */
  projectName?: string | null;
  sandboxProvider: string | null;
  sandboxContainerId: string | null;
  costUsd: number | null;
}

// ===== Session Detail =====

export interface SessionDetail extends SessionListItem {
  codespaceId: string;
  url: string;
  events: SessionEvent[];
  /** Files modified during session */
  filesModified: number;
  /** Lines added */
  linesAdded: number;
  /** Lines removed */
  linesRemoved: number;
  /** Tests run count */
  testsRun: number;
  /** Tests passed count */
  testsPassed: number;
  /** Skill ID from the associated task (null if no skill) */
  skillId: string | null;
  /** Skill display name from the associated task */
  skillName: string | null;
}

// ===== Stream Entry Types =====

export type StreamEntryType = 'system' | 'user' | 'assistant' | 'tool' | 'approval';

export interface StreamEntry {
  id: string;
  type: StreamEntryType;
  timestamp: number;
  /** Formatted time offset from session start (e.g. "1:35" or "1:23:45" for times over an hour) */
  timeOffset: string;
  content: string;
  /** Tool call details if type is 'tool' */
  toolCall?: Readonly<{
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly output?: unknown;
    readonly status: ToolCallStatus;
    /** Time offset when tool started */
    readonly startTimeOffset: string;
    /** Time offset when tool completed (undefined if still running) */
    readonly endTimeOffset?: string;
    /** Duration in milliseconds (undefined if still running) */
    readonly duration?: number;
    /** Error message if status is 'error' */
    readonly error?: string;
  }>;
  /** Model used for this message (assistant messages only) */
  model?: string;
  /** Token usage for this message */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Whether this is the current playback position */
  isCurrent?: boolean;
  /** Whether this entry is from the startup/initialization phase (before first tool call) */
  isStartup?: boolean;
}

// ===== Session Summary Metrics =====

export interface SessionMetrics {
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  testsRun: number;
  testsPassed: number;
  tokensUsed: number;
  turnsUsed: number;
  duration: number | null;
  costUsd: number | null;
}

// ===== Export Types =====

export type ExportFormat = 'json' | 'markdown' | 'csv';

// ===== Date Group =====

export interface SessionDateGroup {
  /** Date label (e.g. "Today", "Yesterday", "Jan 14, 2026") */
  label: string;
  /** ISO date string for grouping */
  date: string;
  /** Sessions in this group */
  sessions: SessionListItem[];
}

// ===== Component Props =====

export interface SessionHistoryPageProps {
  /** Codespace ID to show sessions for */
  codespaceId: string;
  /** Optional task ID to filter sessions */
  taskId?: string;
  /** Initial filters */
  initialFilters?: SessionFilters;
  /** Whether to show in compact mode */
  compact?: boolean;
}

/** Project option for filtering */
export interface ProjectFilterOption {
  id: string;
  name: string;
}

export interface SessionTimelineProps {
  /** Grouped sessions by date */
  groups: SessionDateGroup[];
  /** Currently selected session ID */
  selectedSessionId?: string;
  /** Callback when session is selected */
  onSessionSelect: (sessionId: string) => void;
  /** Total session count */
  totalCount: number;
  /** Total duration (formatted) */
  totalDuration: string;
  /** Loading state */
  isLoading?: boolean;
  /** Available projects for filtering */
  projects?: ProjectFilterOption[];
  /** Currently selected project ID */
  selectedProjectId?: string | null;
  /** Callback when project filter changes */
  onProjectChange?: (projectId: string | null) => void;
}

export interface SessionCardProps {
  /** Session data */
  session: SessionListItem;
  /** Whether this card is selected */
  isSelected?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Compact mode */
  compact?: boolean;
}

export interface SessionDetailViewProps {
  /** Session detail data */
  session: SessionDetail | null;
  /** Loading state */
  isLoading?: boolean;
  /** Callback for export */
  onExport?: (format: ExportFormat) => void;
  /** Callback for delete */
  onDelete?: () => void;
  /** Callback for refresh */
  onRefresh?: () => void;
  /** Callback to navigate to the linked task */
  onViewTask?: (taskId: string, codespaceId: string) => void;
}

export interface StreamViewerProps {
  /** Stream entries to display */
  entries: StreamEntry[];
  /** Current playback position (entry ID) */
  currentEntryId?: string;
  /** Loading state */
  isLoading?: boolean;
}

export interface StreamEntryProps {
  /** Entry data */
  entry: StreamEntry;
  /** Whether this is the current playback position */
  isCurrent?: boolean;
}

export interface SessionSummaryProps {
  /** Session metrics */
  metrics: SessionMetrics;
}

export interface ExportDropdownProps {
  /** Callback when format is selected */
  onExport: (format: ExportFormat) => void;
  /** Disabled state */
  disabled?: boolean;
}

// ===== Tool Call Component Props =====

export interface ToolCallCardProps {
  /** Tool call entry data */
  toolCall: ToolCallEntry;
  /** Whether the card is expanded by default */
  defaultExpanded?: boolean;
  /** Callback when card is expanded/collapsed */
  onExpandedChange?: (expanded: boolean) => void;
}

export interface ToolCallSummaryBarProps {
  /** Tool call statistics */
  stats: ToolCallStats;
}

export interface ToolCallTimelineProps {
  /** Tool call entries to display */
  toolCalls: ToolCallEntry[];
  /** Tool call statistics */
  stats: ToolCallStats;
  /** Loading state */
  isLoading?: boolean;
  /** Filter by tool name */
  filterTool?: string;
  /** Callback when filter changes */
  onFilterChange?: (tool: string | undefined) => void;
}

// ===== Status Colors =====

export const SESSION_STATUS_COLORS: Record<
  SessionStatus,
  {
    dot: string;
    badge: string;
    text: string;
  }
> = {
  idle: {
    dot: 'bg-fg-subtle',
    badge: 'bg-fg-subtle/15',
    text: 'text-fg-muted',
  },
  initializing: {
    dot: 'bg-accent',
    badge: 'bg-accent/15',
    text: 'text-accent',
  },
  active: {
    dot: 'bg-success animate-pulse',
    badge: 'bg-success/15',
    text: 'text-success',
  },
  paused: {
    dot: 'bg-attention',
    badge: 'bg-attention/15',
    text: 'text-attention',
  },
  closing: {
    dot: 'bg-fg-subtle',
    badge: 'bg-fg-subtle/15',
    text: 'text-fg-muted',
  },
  closed: {
    dot: 'bg-done',
    badge: 'bg-done/15',
    text: 'text-done',
  },
  error: {
    dot: 'bg-danger',
    badge: 'bg-danger/15',
    text: 'text-danger',
  },
};

// ===== Stream Entry Type Config =====

export const STREAM_ENTRY_TYPE_CONFIG: Record<
  StreamEntryType,
  {
    label: string;
    textClass: string;
  }
> = {
  system: {
    label: 'System',
    textClass: 'text-fg-muted',
  },
  user: {
    label: 'User',
    textClass: 'text-accent',
  },
  assistant: {
    label: 'Assistant',
    textClass: 'text-done',
  },
  tool: {
    label: 'Tool Call',
    textClass: 'text-attention',
  },
  approval: {
    label: 'Approval',
    textClass: 'text-secondary-emphasis',
  },
};

// Re-export types from session service for convenience
export type { SessionEvent, SessionEventType };
