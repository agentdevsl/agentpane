/**
 * FC-005: Refactored from useState to useReducer with discriminated union actions.
 * FC-006: Uses useSessionSubscription for shared SSE connection.
 */
import { useCallback, useEffectEvent, useReducer, useRef } from 'react';
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
import { useMountEffect } from './use-mount-effect';
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
  | { type: 'FILE_CHANGED'; data: ContainerAgentFileChanged };

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
        streamedText: action.data.accumulated,
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

    default:
      return state;
  }
}

/**
 * Hook for subscribing to container agent events.
 *
 * FC-005: Uses useReducer with discriminated union actions instead of useState.
 * FC-006: Uses useSessionSubscription for shared SSE connections.
 *
 * @param sessionId - The session ID to subscribe to
 * @returns Container agent state and connection state
 */
export function useContainerAgent(sessionId: string | null): {
  state: ContainerAgentState;
  connectionState: ConnectionState;
  isStreaming: boolean;
} {
  const [state, dispatch] = useReducer(containerAgentReducer, initialState);

  // Build callbacks that dispatch actions
  const callbacks = useRef<SessionCallbacks>({});

  const buildCallbacks = useCallback((): SessionCallbacks => {
    return {
      onContainerAgentStatus: (event) => dispatch({ type: 'STATUS', data: event.data }),
      onContainerAgentStarted: (event) => dispatch({ type: 'STARTED', data: event.data }),
      onContainerAgentToken: (event) => dispatch({ type: 'TOKEN', data: event.data }),
      onContainerAgentTurn: (event) => dispatch({ type: 'TURN', data: event.data }),
      onContainerAgentToolStart: (event) => dispatch({ type: 'TOOL_START', data: event.data }),
      onContainerAgentToolResult: (event) => dispatch({ type: 'TOOL_RESULT', data: event.data }),
      onContainerAgentMessage: (event) => dispatch({ type: 'MESSAGE', data: event.data }),
      onContainerAgentComplete: (event) => dispatch({ type: 'COMPLETE', data: event.data }),
      onContainerAgentError: (event) => dispatch({ type: 'ERROR', data: event.data }),
      onContainerAgentCancelled: (event) => dispatch({ type: 'CANCELLED', data: event.data }),
      onContainerAgentPlanReady: (event) => dispatch({ type: 'PLAN_READY', data: event.data }),
      onContainerAgentWorktree: (event) => dispatch({ type: 'WORKTREE', data: event.data }),
      onContainerAgentFileChanged: (event) => dispatch({ type: 'FILE_CHANGED', data: event.data }),
      onError: (error) => {
        console.error('[useContainerAgent] Stream error:', error);
      },
      onReconnect: () => {
        console.log('[useContainerAgent] Reconnected to session stream');
      },
      onDisconnect: () => {
        console.log('[useContainerAgent] Disconnected from session stream');
      },
    };
  }, []);

  // Keep callbacks ref in sync — useEffectEvent always sees the latest buildCallbacks
  const stableBuild = useEffectEvent(() => buildCallbacks());

  useMountEffect(() => {
    callbacks.current = stableBuild();
  });

  // Reset state when sessionId changes to null
  useWatchEffect(() => {
    if (!sessionId) {
      dispatch({ type: 'RESET' });
    }
  }, [sessionId]);

  const { connectionState } = useSessionSubscription(sessionId, callbacks.current);

  return { state, connectionState, isStreaming: state.isStreaming };
}
