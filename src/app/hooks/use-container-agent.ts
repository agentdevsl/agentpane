/**
 * FC-005: Refactored from useState to useReducer with discriminated union actions.
 * FC-006: Uses useSessionSubscription for shared SSE connection.
 * FC-031: Falls back to REST historical events when SSE stream is unavailable
 *         (completed/cancelled/error sessions).
 */
import { useCallback, useReducer, useRef } from 'react';
import type { SessionStatus } from '@/db/schema/shared/enums.js';
import { apiClient } from '@/lib/api/client';
import type {
  ConnectionState,
  ContainerAgentComplete,
  ContainerAgentError,
  ContainerAgentFileChanged,
  ContainerAgentPlanReady,
  ContainerAgentStarted,
  ContainerAgentStatus,
  ContainerAgentToken,
  ContainerAgentToolResult,
  ContainerAgentToolStart,
  ContainerAgentTurn,
  ContainerAgentWorktree,
  SessionCallbacks,
} from '@/lib/streams/client';
import type { TopologyEvent } from '@/lib/topology/build-from-events';
import { useSessionSubscription } from './use-session-subscription';
import { useWatchEffect } from './use-watch-effect';

/**
 * Container agent startup stage
 */
export type ContainerAgentStage =
  | 'initializing'
  | 'validating'
  | 'credentials'
  | 'injecting_skills'
  | 'creating_sandbox'
  | 'executing'
  | 'running';

/**
 * Status breadcrumb entry
 */
export interface ContainerAgentStatusEntry {
  stage: ContainerAgentStage;
  message: string;
  timestamp: number;
}

/**
 * Container agent tool execution state
 */
export interface ContainerAgentToolExecution {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: 'running' | 'complete' | 'error';
  startedAt: number;
  completedAt?: number;
}

/**
 * File change tracked during agent execution
 */
export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  toolName: string;
  additions?: number;
  deletions?: number;
  timestamp: number;
}

/**
 * Container agent state
 */
export interface ContainerAgentState {
  /** Agent execution status */
  status: 'idle' | 'starting' | 'running' | 'completed' | 'plan_ready' | 'error' | 'cancelled';
  /** Current startup stage (breadcrumb progress) */
  currentStage?: ContainerAgentStage;
  /** Current status message */
  statusMessage?: string;
  /** Status breadcrumb history */
  statusHistory: ContainerAgentStatusEntry[];
  /** Model being used */
  model?: string;
  /** Git branch for the agent's worktree */
  branch?: string;
  /** Maximum turns allowed */
  maxTurns?: number;
  /** Current turn number */
  currentTurn: number;
  /** Remaining turns */
  remainingTurns: number;
  /** Accumulated text from streaming tokens */
  streamedText: string;
  /** Tool executions */
  toolExecutions: ContainerAgentToolExecution[];
  /** Files changed by the agent */
  fileChanges: FileChange[];
  /** Messages from the agent */
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }>;
  /** Final result if completed */
  result?: string;
  /** Error message if failed */
  error?: string;
  /** Error code if failed */
  errorCode?: string;
  /** Plan content if plan_ready */
  plan?: string;
  /** Sandbox provider (docker or kubernetes) */
  sandboxProvider?: string;
  /** Sandbox container ID */
  sandboxContainerId?: string;
  /** Started timestamp */
  startedAt?: number;
  /** Completed timestamp */
  completedAt?: number;
  /** Whether tokens are currently streaming */
  isStreaming: boolean;
}

type ContainerAgentStreamEvent<TData> = {
  data: TData;
  cursor?: string;
  meta?: { eventId?: string };
};

const initialState: ContainerAgentState = {
  status: 'idle',
  statusHistory: [],
  branch: undefined,
  currentTurn: 0,
  remainingTurns: 0,
  streamedText: '',
  toolExecutions: [],
  fileChanges: [],
  messages: [],
  isStreaming: false,
};

// =============================================================================
// FC-031: Historical event replay types and processing
// =============================================================================

interface HistoricalLoadResult {
  messages: ContainerAgentState['messages'];
  toolExecutions: ContainerAgentToolExecution[];
  fileChanges: FileChange[];
  status: ContainerAgentState['status'];
  statusHistory: ContainerAgentStatusEntry[];
  currentTurn: number;
  remainingTurns: number;
  maxTurns?: number;
  model?: string;
  branch?: string;
  plan?: string;
  result?: string;
  error?: string;
  errorCode?: string;
  startedAt?: number;
  completedAt?: number;
  sandboxProvider?: string;
  sandboxContainerId?: string;
}

/**
 * Build container agent state from historical REST events.
 * Replays events in order to reconstruct the same state shape
 * that the live SSE reducer would produce.
 */
function buildStateFromHistoricalEvents(events: TopologyEvent[]): HistoricalLoadResult {
  const messages: ContainerAgentState['messages'] = [];
  const toolExecutions: ContainerAgentToolExecution[] = [];
  const fileChanges: FileChange[] = [];
  const statusHistory: ContainerAgentStatusEntry[] = [];
  let status: ContainerAgentState['status'] = 'idle';
  let currentTurn = 0;
  let remainingTurns = 0;
  let maxTurns: number | undefined;
  let model: string | undefined;
  let branch: string | undefined;
  let plan: string | undefined;
  let result: string | undefined;
  let error: string | undefined;
  let errorCode: string | undefined;
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let sandboxProvider: string | undefined;
  let sandboxContainerId: string | undefined;

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case 'container-agent:status':
        statusHistory.push({
          stage: data.stage as ContainerAgentStage,
          message: data.message as string,
          timestamp: event.timestamp,
        });
        break;

      case 'container-agent:started':
        status = 'running';
        model = data.model as string | undefined;
        maxTurns = data.maxTurns as number | undefined;
        remainingTurns = maxTurns ?? 0;
        sandboxProvider = data.sandboxProvider as string | undefined;
        sandboxContainerId = data.sandboxContainerId as string | undefined;
        startedAt = event.timestamp;
        break;

      case 'container-agent:message':
        messages.push({
          role: (data.role as 'user' | 'assistant' | 'system') ?? 'assistant',
          content: (data.content as string) ?? '',
          timestamp: event.timestamp,
        });
        break;

      case 'container-agent:turn':
        currentTurn = (data.turn as number) ?? currentTurn;
        remainingTurns = (data.remaining as number) ?? remainingTurns;
        break;

      case 'container-agent:tool:start': {
        const toolId = (data.toolId as string) ?? (data.id as string) ?? '';
        toolExecutions.push({
          toolId,
          toolName: (data.toolName as string) ?? 'Unknown',
          input: (data.input as Record<string, unknown>) ?? {},
          status: 'running',
          startedAt: event.timestamp,
        });
        break;
      }

      case 'container-agent:tool:result': {
        const resultToolId = (data.toolId as string) ?? (data.id as string) ?? '';
        const existingTool = toolExecutions.find((t) => t.toolId === resultToolId);
        if (existingTool) {
          existingTool.result = data.result as string | undefined;
          existingTool.isError = data.isError as boolean | undefined;
          existingTool.durationMs = data.durationMs as number | undefined;
          existingTool.status = data.isError ? 'error' : 'complete';
          existingTool.completedAt = event.timestamp;
        } else {
          toolExecutions.push({
            toolId: resultToolId,
            toolName: (data.toolName as string) ?? 'Unknown',
            input: (data.input as Record<string, unknown>) ?? {},
            result: data.result as string | undefined,
            isError: data.isError as boolean | undefined,
            durationMs: data.durationMs as number | undefined,
            status: data.isError ? 'error' : 'complete',
            startedAt: event.timestamp,
            completedAt: event.timestamp,
          });
        }
        break;
      }

      case 'container-agent:complete':
        status =
          (data.status as string) === 'completed'
            ? 'completed'
            : (data.status as string) === 'cancelled'
              ? 'cancelled'
              : (data.status as string) === 'turn_limit'
                ? 'completed'
                : 'error';
        result = data.result as string | undefined;
        completedAt = event.timestamp;
        break;

      case 'container-agent:error':
        status = 'error';
        error = data.error as string | undefined;
        errorCode = data.code as string | undefined;
        completedAt = event.timestamp;
        break;

      case 'container-agent:cancelled':
        status = 'cancelled';
        completedAt = event.timestamp;
        break;

      case 'container-agent:plan_ready':
        status = 'plan_ready';
        plan = data.plan as string | undefined;
        result = 'Plan ready for review';
        completedAt = event.timestamp;
        break;

      case 'container-agent:worktree':
        branch = data.branch as string | undefined;
        break;

      case 'container-agent:file_changed': {
        const filePath = data.path as string;
        const existingIdx = fileChanges.findIndex((f) => f.path === filePath);
        const change: FileChange = {
          path: filePath,
          action: data.action as 'create' | 'modify' | 'delete',
          toolName: data.toolName as string,
          additions: data.additions as number | undefined,
          deletions: data.deletions as number | undefined,
          timestamp: event.timestamp,
        };
        if (existingIdx >= 0) {
          fileChanges[existingIdx] = change;
        } else {
          fileChanges.push(change);
        }
        break;
      }
      // Skip token events -- they are high-frequency streaming deltas
      // and the accumulated text is captured by container-agent:message events
      default:
        break;
    }
  }

  return {
    messages,
    toolExecutions,
    fileChanges,
    status,
    statusHistory,
    currentTurn,
    remainingTurns,
    maxTurns,
    model,
    branch,
    plan,
    result,
    error,
    errorCode,
    startedAt,
    completedAt,
    sandboxProvider,
    sandboxContainerId,
  };
}

// =============================================================================
// FC-005: Discriminated union action types
// =============================================================================

type ContainerAgentAction =
  | { type: 'RESET' }
  | { type: 'STATUS'; data: ContainerAgentStatus }
  | { type: 'STARTED'; data: ContainerAgentStarted }
  | { type: 'TOKEN'; data: ContainerAgentToken }
  | { type: 'TURN'; data: ContainerAgentTurn }
  | { type: 'TOOL_START'; data: ContainerAgentToolStart }
  | { type: 'TOOL_RESULT'; data: ContainerAgentToolResult }
  | {
      type: 'MESSAGE';
      data: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: number };
    }
  | { type: 'COMPLETE'; data: ContainerAgentComplete }
  | { type: 'ERROR'; data: ContainerAgentError }
  | { type: 'CANCELLED'; data: { turnCount: number; timestamp: number } }
  | { type: 'PLAN_READY'; data: ContainerAgentPlanReady }
  | { type: 'WORKTREE'; data: ContainerAgentWorktree }
  | { type: 'FILE_CHANGED'; data: ContainerAgentFileChanged }
  | { type: 'LOAD_HISTORICAL'; data: HistoricalLoadResult };

function containerAgentReducer(
  state: ContainerAgentState,
  action: ContainerAgentAction
): ContainerAgentState {
  switch (action.type) {
    case 'RESET':
      return initialState;

    case 'STATUS':
      return {
        ...state,
        status: 'starting',
        currentStage: action.data.stage,
        statusMessage: action.data.message,
        statusHistory: [
          ...state.statusHistory,
          {
            stage: action.data.stage,
            message: action.data.message,
            timestamp: action.data.timestamp,
          },
        ],
      };

    case 'STARTED':
      return {
        ...state,
        status: 'starting',
        model: action.data.model,
        maxTurns: action.data.maxTurns,
        remainingTurns: action.data.maxTurns,
        sandboxProvider: action.data.sandboxProvider,
        sandboxContainerId: action.data.sandboxContainerId,
        startedAt: action.data.timestamp,
      };

    case 'TOKEN':
      return {
        ...state,
        status: 'running',
        streamedText: state.streamedText + action.data.delta,
        isStreaming: true,
      };

    case 'TURN':
      return {
        ...state,
        status: 'running',
        currentTurn: action.data.turn,
        remainingTurns: action.data.remaining,
      };

    case 'TOOL_START': {
      // Check if tool already exists to prevent duplicates on reconnection
      const existingIndex = state.toolExecutions.findIndex((t) => t.toolId === action.data.toolId);
      if (existingIndex >= 0) {
        return state;
      }
      const newTool: ContainerAgentToolExecution = {
        toolId: action.data.toolId,
        toolName: action.data.toolName,
        input: action.data.input,
        status: 'running',
        startedAt: action.data.timestamp,
      };
      let tools = [...state.toolExecutions, newTool];
      if (tools.length > 500) {
        // Keep running tools + most recent completed
        const running = tools.filter((t) => t.status === 'running');
        const completed = tools.filter((t) => t.status !== 'running');
        tools = [...completed.slice(-400), ...running];
      }
      return { ...state, toolExecutions: tools };
    }

    case 'TOOL_RESULT':
      return {
        ...state,
        toolExecutions: state.toolExecutions.map((tool) =>
          tool.toolId === action.data.toolId
            ? {
                ...tool,
                result: action.data.result,
                isError: action.data.isError,
                durationMs: action.data.durationMs,
                status: action.data.isError ? 'error' : 'complete',
                completedAt: action.data.timestamp,
              }
            : tool
        ),
      };

    case 'MESSAGE': {
      const messages =
        state.messages.length >= 500
          ? [...state.messages.slice(-400), action.data]
          : [...state.messages, action.data];
      return { ...state, messages, streamedText: '', isStreaming: false };
    }

    case 'COMPLETE':
      return {
        ...state,
        status:
          action.data.status === 'completed'
            ? 'completed'
            : action.data.status === 'cancelled'
              ? 'cancelled'
              : 'error',
        result: action.data.result,
        completedAt: action.data.timestamp,
        isStreaming: false,
      };

    case 'ERROR':
      return {
        ...state,
        status: 'error',
        error: action.data.error,
        errorCode: action.data.code,
        completedAt: action.data.timestamp,
        isStreaming: false,
      };

    case 'CANCELLED':
      return {
        ...state,
        status: 'cancelled',
        completedAt: action.data.timestamp,
        isStreaming: false,
      };

    case 'PLAN_READY':
      return {
        ...state,
        status: 'plan_ready',
        plan: action.data.plan,
        result: 'Plan ready for review',
        completedAt: action.data.timestamp,
        isStreaming: false,
      };

    case 'WORKTREE':
      return {
        ...state,
        branch: action.data.branch,
      };

    case 'FILE_CHANGED': {
      // Deduplicate by path -- update existing entry for the same file
      const existingFileIdx = state.fileChanges.findIndex((f) => f.path === action.data.path);
      if (existingFileIdx >= 0) {
        const updated = [...state.fileChanges];
        updated[existingFileIdx] = {
          path: action.data.path,
          action: action.data.action,
          toolName: action.data.toolName,
          additions: action.data.additions,
          deletions: action.data.deletions,
          timestamp: action.data.timestamp,
        };
        return { ...state, fileChanges: updated };
      }
      return {
        ...state,
        fileChanges: [
          ...state.fileChanges,
          {
            path: action.data.path,
            action: action.data.action,
            toolName: action.data.toolName,
            additions: action.data.additions,
            deletions: action.data.deletions,
            timestamp: action.data.timestamp,
          },
        ],
      };
    }

    case 'LOAD_HISTORICAL':
      return {
        ...state,
        ...action.data,
        streamedText: '',
        isStreaming: false,
      };

    default:
      return state;
  }
}

function getStableEventId<TData>(
  event: ContainerAgentStreamEvent<TData>,
  fallback: string
): string {
  return event.meta?.eventId ?? event.cursor ?? fallback;
}

/**
 * Terminal session statuses that will never produce new SSE events.
 * When a session has one of these statuses, we skip the SSE stream
 * and go straight to the REST historical fetch.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  'closed',
  'error',
]);

/**
 * Hook for subscribing to container agent events.
 *
 * FC-005: Uses useReducer with discriminated union actions instead of useState.
 * FC-006: Uses useSessionSubscription for shared SSE connections.
 * FC-031: Falls back to REST historical events when the SSE stream is unavailable.
 *
 * @param sessionId - The session ID to subscribe to
 * @param options.sessionStatus - Session status from the DB (used to skip SSE for completed sessions)
 * @returns Container agent state and connection state
 */
export function useContainerAgent(
  sessionId: string | null,
  options?: { sessionStatus?: string }
): {
  state: ContainerAgentState;
  connectionState: ConnectionState;
  isStreaming: boolean;
} {
  const [state, dispatch] = useReducer(containerAgentReducer, initialState);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const historicalFetchedRef = useRef<string | null>(null);
  const streamErrorCountRef = useRef(0);

  // Determine if the session is terminal (completed/cancelled/error) upfront.
  // Terminal sessions will never produce SSE events, so skip the stream entirely.
  const isTerminalSession = options?.sessionStatus
    ? TERMINAL_SESSION_STATUSES.has(options.sessionStatus)
    : false;

  /**
   * Fetch historical events from the REST API and replay them into the reducer.
   */
  const fetchHistoricalEvents = useCallback(async (sid: string) => {
    // Prevent duplicate fetches for the same session
    if (historicalFetchedRef.current === sid) return;
    historicalFetchedRef.current = sid;

    try {
      const result = await apiClient.sessions.getEvents(sid, { limit: 500 });
      if (!result.ok) {
        console.error('[useContainerAgent] Failed to fetch historical events:', result.error);
        // Allow retry on next trigger by clearing the ref
        historicalFetchedRef.current = null;
        dispatch({
          type: 'ERROR',
          data: {
            error: 'Failed to load session history. Try refreshing the page.',
            code: 'HISTORICAL_FETCH_FAILED',
            timestamp: Date.now(),
          } as ContainerAgentError,
        });
        return;
      }

      const events = result.data;
      if (events.length === 0) return;

      const historicalState = buildStateFromHistoricalEvents(events as TopologyEvent[]);
      dispatch({ type: 'LOAD_HISTORICAL', data: historicalState });
    } catch (err) {
      console.error('[useContainerAgent] Error fetching historical events:', err);
      // Allow retry on next trigger by clearing the ref
      historicalFetchedRef.current = null;
      dispatch({
        type: 'ERROR',
        data: {
          error: `Failed to load session history: ${err instanceof Error ? err.message : 'Unknown error'}. Try refreshing the page.`,
          code: 'HISTORICAL_FETCH_ERROR',
          timestamp: Date.now(),
        } as ContainerAgentError,
      });
    }
  }, []);

  const handleEvent = <TData>(
    event: ContainerAgentStreamEvent<TData>,
    fallbackId: string,
    onEvent: () => void
  ): void => {
    const eventId = getStableEventId(event, fallbackId);
    if (seenEventIdsRef.current.has(eventId)) {
      return;
    }

    seenEventIdsRef.current.add(eventId);
    onEvent();
  };

  const callbacks: SessionCallbacks = {
    onContainerAgentStatus: (event) => {
      handleEvent(
        event,
        `container-agent:status:${event.data.stage}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'STATUS', data: event.data });
        }
      );
    },
    onContainerAgentStarted: (event) => {
      handleEvent(
        event,
        `container-agent:started:${event.data.timestamp}:${event.data.model}`,
        () => {
          dispatch({ type: 'STARTED', data: event.data });
        }
      );
    },
    onContainerAgentToken: (event) => {
      handleEvent(
        event,
        `container-agent:token:${event.data.timestamp}:${event.data.delta}`,
        () => {
          dispatch({ type: 'TOKEN', data: event.data });
        }
      );
    },
    onContainerAgentTurn: (event) => {
      handleEvent(event, `container-agent:turn:${event.data.turn}:${event.data.timestamp}`, () => {
        dispatch({ type: 'TURN', data: event.data });
      });
    },
    onContainerAgentToolStart: (event) => {
      handleEvent(
        event,
        `container-agent:tool:start:${event.data.toolId}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'TOOL_START', data: event.data });
        }
      );
    },
    onContainerAgentToolResult: (event) => {
      handleEvent(
        event,
        `container-agent:tool:result:${event.data.toolId}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'TOOL_RESULT', data: event.data });
        }
      );
    },
    onContainerAgentMessage: (event) => {
      handleEvent(
        event,
        `container-agent:message:${event.data.role}:${event.data.timestamp}:${event.data.content}`,
        () => {
          dispatch({ type: 'MESSAGE', data: event.data });
        }
      );
    },
    onContainerAgentComplete: (event) => {
      handleEvent(
        event,
        `container-agent:complete:${event.data.status}:${event.data.turnCount}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'COMPLETE', data: event.data });
        }
      );
    },
    onContainerAgentError: (event) => {
      handleEvent(
        event,
        `container-agent:error:${event.data.code ?? 'unknown'}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'ERROR', data: event.data });
        }
      );
    },
    onContainerAgentCancelled: (event) => {
      handleEvent(
        event,
        `container-agent:cancelled:${event.data.turnCount}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'CANCELLED', data: event.data });
        }
      );
    },
    onContainerAgentPlanReady: (event) => {
      handleEvent(
        event,
        `container-agent:plan-ready:${event.data.sdkSessionId}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'PLAN_READY', data: event.data });
        }
      );
    },
    onContainerAgentWorktree: (event) => {
      handleEvent(
        event,
        `container-agent:worktree:${event.data.worktreeId}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'WORKTREE', data: event.data });
        }
      );
    },
    onContainerAgentFileChanged: (event) => {
      handleEvent(
        event,
        `container-agent:file-changed:${event.data.path}:${event.data.timestamp}`,
        () => {
          dispatch({ type: 'FILE_CHANGED', data: event.data });
        }
      );
    },
    onError: (error) => {
      console.error('[useContainerAgent] Stream error:', error);
      // FC-031: After repeated stream errors, fall back to historical REST fetch.
      // This handles the case where the SSE endpoint returns 404 for completed sessions.
      streamErrorCountRef.current += 1;
      if (streamErrorCountRef.current >= 2 && sessionId) {
        void fetchHistoricalEvents(sessionId);
      }
    },
    onReconnect: () => {
      console.log('[useContainerAgent] Reconnected to session stream');
      streamErrorCountRef.current = 0;
    },
    onDisconnect: () => {
      console.log('[useContainerAgent] Disconnected from session stream');
    },
  };

  // Reset state and dedupe cache when session changes
  useWatchEffect(() => {
    seenEventIdsRef.current.clear();
    historicalFetchedRef.current = null;
    streamErrorCountRef.current = 0;
    dispatch({ type: 'RESET' });
  }, [sessionId]);

  // FC-031: For terminal sessions, skip SSE entirely and fetch historical events.
  // Pass null sessionId to useSessionSubscription to avoid opening a stream.
  const effectiveSessionId = isTerminalSession ? null : sessionId;
  const { connectionState } = useSessionSubscription(effectiveSessionId, callbacks);

  // FC-031: Immediately fetch historical events for terminal sessions
  useWatchEffect(() => {
    if (isTerminalSession && sessionId) {
      void fetchHistoricalEvents(sessionId);
    }
  }, [isTerminalSession, sessionId, fetchHistoricalEvents]);

  // Derive effective connection state: for terminal sessions with loaded data,
  // report as 'disconnected' (expected -- no live stream needed)
  const effectiveConnectionState = isTerminalSession ? 'disconnected' : connectionState;

  return { state, connectionState: effectiveConnectionState, isStreaming: state.isStreaming };
}
