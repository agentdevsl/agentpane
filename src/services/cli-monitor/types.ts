// ── Session Status ──
export type CliSessionStatus =
  | 'working' // Assistant is actively generating or tools are running
  | 'waiting_for_approval' // Tool use pending approval (permission required)
  | 'waiting_for_input' // Turn complete, waiting for user message
  | 'idle'; // No activity for IDLE_TIMEOUT_MS

// ── Aggregate Status (for ambient UI) ──
export type AggregateStatus = 'nominal' | 'attention' | 'idle';

// ── Agent Topology ──
export type AgentNodeType = string;

export interface QueueOperation {
  operation: string;
  timestamp: number;
  content?: string;
  version?: string;
}

export interface ToolInvocation {
  toolName: string;
  toolId: string;
  timestamp: number;
  isError?: boolean;
  durationMs?: number;
  resultNumFiles?: number;
  resultNumLines?: number;
}

export interface AgentTopologyNode {
  sessionId: string;
  agentId?: string;
  agentType: AgentNodeType;
  parentSessionId?: string;
  childSessionIds: string[];
  depth: number;
  spawnedAt?: number;
  completedAt?: number;
  status: CliSessionStatus | 'completed';
  tokenUsage: CliSession['tokenUsage'];
  turnCount: number;
  messageCount: number;
}

// ── Session State ──
export interface CliSession {
  sessionId: string; // UUID from JSONL sessionId field
  filePath: string; // Absolute path to the .jsonl file
  cwd: string; // Working directory from system event
  projectName: string; // Extracted from cwd (basename)
  projectHash: string; // Directory name under ~/.claude/projects/
  gitBranch?: string; // From JSONL gitBranch field
  status: CliSessionStatus;
  messageCount: number; // Count of user + assistant messages
  turnCount: number; // Count of assistant turns
  goal?: string; // First user message text (truncated to 200 chars)
  recentOutput?: string; // Last assistant text content (truncated to 500 chars)
  pendingToolUse?: {
    // Set when tool_use seen without tool_result
    toolName: string;
    toolId: string;
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    ephemeral5mTokens?: number;
    ephemeral1hTokens?: number;
  };
  model?: string; // From assistant message.model field
  startedAt: number; // Timestamp of first event (ms)
  lastActivityAt: number; // Timestamp of most recent event (ms)
  lastReadOffset: number; // Byte offset for incremental file reading
  isSubagent: boolean; // True if file is in /subagents/ directory
  parentSessionId?: string; // Parent session ID if subagent
  slug?: string;
  version?: string;
  permissionMode?: string;
  maxThinkingTokens?: number;
  isSidechain?: boolean;
  lastTurnDurationMs?: number;
  avgTurnDurationMs?: number;
  queueOperations?: QueueOperation[];
  recentToolInvocations?: ToolInvocation[];
  topology?: AgentTopologyNode;
  performanceMetrics?: PerformanceMetrics;
}

// ── Performance Metrics ──
export interface TurnMetrics {
  turnNumber: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  timestamp: number;
  durationMs?: number;
}

export type HealthStatus = 'healthy' | 'warning' | 'critical';

export interface CompactionEvent {
  type: 'compact' | 'microcompact';
  timestamp: number;
  trigger: string;
  preTokens: number;
  tokensSaved?: number;
  sessionId: string;
  parentSessionId?: string;
  compactedToolIds?: string[];
}

export interface PerformanceMetrics {
  compactionCount: number;
  lastCompactionAt: number | null;
  compactionEvents: CompactionEvent[];
  recentTurns: TurnMetrics[];
  cacheHitRatio: number;
  contextWindowUsed: number;
  contextWindowLimit: number;
  contextPressure: number;
  healthStatus: HealthStatus;
}

// ── Daemon Info ──
export interface DaemonInfo {
  daemonId: string;
  pid: number;
  version: string;
  watchPath: string;
  capabilities: string[];
  registeredAt: number;
  lastHeartbeatAt: number;
}

// ── Daemon Registration Payload ──
export interface DaemonRegisterPayload {
  daemonId: string;
  pid: number;
  version: string;
  watchPath: string;
  capabilities: string[];
  startedAt: number;
}

// ── Daemon Heartbeat Payload ──
export interface DaemonHeartbeatPayload {
  daemonId: string;
  sessionCount: number;
}

// ── Daemon Ingest Payload ──
export interface DaemonIngestPayload {
  daemonId: string;
  sessions: CliSession[];
  removedSessionIds: string[];
}

// ── Daemon Deregister Payload ──
export interface DaemonDeregisterPayload {
  daemonId: string;
}

// ── SSE Event Types ──
export type CliMonitorEventType =
  | 'cli-monitor:snapshot'
  | 'cli-monitor:session-update'
  | 'cli-monitor:session-removed'
  | 'cli-monitor:status-change'
  | 'cli-monitor:daemon-connected'
  | 'cli-monitor:daemon-disconnected';

export interface CliMonitorSnapshot {
  type: 'cli-monitor:snapshot';
  sessions: CliSession[];
  daemon: DaemonInfo | null;
  connected: boolean;
}

export interface CliMonitorSessionUpdate {
  type: 'cli-monitor:session-update';
  session: CliSession;
  previousStatus?: CliSessionStatus;
}

export interface CliMonitorSessionRemoved {
  type: 'cli-monitor:session-removed';
  sessionId: string;
}

export interface CliMonitorStatusChange {
  type: 'cli-monitor:status-change';
  sessionId: string;
  previousStatus: CliSessionStatus;
  newStatus: CliSessionStatus;
  timestamp: number;
}

export interface CliMonitorDaemonConnected {
  type: 'cli-monitor:daemon-connected';
  daemon: DaemonInfo;
}

export interface CliMonitorDaemonDisconnected {
  type: 'cli-monitor:daemon-disconnected';
}

export type CliMonitorEvent =
  | CliMonitorSnapshot
  | CliMonitorSessionUpdate
  | CliMonitorSessionRemoved
  | CliMonitorStatusChange
  | CliMonitorDaemonConnected
  | CliMonitorDaemonDisconnected;

// ── Status Derivation ──
export function deriveAggregateStatus(sessions: CliSession[]): AggregateStatus {
  if (sessions.length === 0) return 'idle';

  let hasWorking = false;
  for (const s of sessions) {
    if (s.status === 'working') hasWorking = true;
    if (s.status === 'waiting_for_approval' || s.status === 'waiting_for_input') return 'attention';
  }

  if (hasWorking) return 'nominal';
  return 'idle';
}

// ── JSONL Raw Event Types (from Claude Code CLI) ──
export type RawCliEventType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'queue-operation'
  | 'summary'
  | 'progress'
  | 'file-history-snapshot';

export interface RawContentBlockText {
  type: 'text';
  text: string;
}

export interface RawContentBlockThinking {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface RawContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface RawContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type RawContentBlock =
  | RawContentBlockText
  | RawContentBlockThinking
  | RawContentBlockToolUse
  | RawContentBlockToolResult;

// ── Extended Usage (from Claude API) ──
export interface RawTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
}

// ── Progress Event Data ──
export interface RawProgressData {
  type: 'hook_progress';
  hookEvent: string;
  hookName: string;
  command: string;
}

export interface RawCliEvent {
  type: RawCliEventType;
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch?: string;
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external';
  agentId?: string;

  // Present on assistant events
  requestId?: string;

  // Meta message flag
  isMeta?: boolean;

  // Thinking configuration
  thinkingMetadata?: { maxThinkingTokens: number };

  // Links tool result to requesting assistant
  sourceToolAssistantUUID?: string;

  // Present on summary events
  leafUuid?: string;

  // System event fields
  subtype?: string;
  level?: string;
  hookCount?: number;
  hookInfos?: Array<{ command: string }>;
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  hasOutput?: boolean;
  toolUseID?: string;

  message?: {
    role: 'user' | 'assistant';
    id?: string;
    type?: string;
    model?: string;
    content: string | RawContentBlock[];
    usage?: RawTokenUsage;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  permissionMode?: string;
  summary?: string;
  operation?: string;
  toolUseResult?:
    | string
    | {
        stdout: string;
        stderr: string;
        interrupted: boolean;
        isImage: boolean;
      };

  // Progress event data
  progressData?: RawProgressData;
}

// ── Constants ──
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DAEMON_HEARTBEAT_INTERVAL_MS = 10 * 1000; // 10 seconds
export const DAEMON_TIMEOUT_MS = 30 * 1000; // 30 seconds
export const INGEST_BATCH_INTERVAL_MS = 500; // Batch updates every 500ms
export const GOAL_MAX_LENGTH = 200;
export const RECENT_OUTPUT_MAX_LENGTH = 500;
