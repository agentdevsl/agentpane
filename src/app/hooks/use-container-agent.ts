import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectionState,
  type ContainerAgentComplete,
  type ContainerAgentError,
  type ContainerAgentFileChanged,
  type ContainerAgentPlanReady,
  type ContainerAgentStarted,
  type ContainerAgentStatus,
  type ContainerAgentToken,
  type ContainerAgentToolResult,
  type ContainerAgentToolStart,
  type ContainerAgentTurn,
  type ContainerAgentWorktree,
  type SessionCallbacks,
  type Subscription,
  subscribeToSession,
} from '@/lib/streams/client';

/**
 * Container agent startup stage
 */
export type ContainerAgentStage =
  | 'initializing'
  | 'validating'
  | 'credentials'
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
};

/**
 * Hook for subscribing to container agent events
 *
 * @param sessionId - The session ID to subscribe to
 * @returns Container agent state and connection state
 */
export function useContainerAgent(sessionId: string | null): {
  state: ContainerAgentState;
  connectionState: ConnectionState;
  isStreaming: boolean;
} {
  const [state, setState] = useState<ContainerAgentState>(initialState);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isStreaming, setIsStreaming] = useState(false);
  const subscriptionRef = useRef<Subscription | null>(null);

  // Handle status update (breadcrumb progress)
  const handleStatus = useCallback((data: ContainerAgentStatus) => {
    setState((prev) => ({
      ...prev,
      status: 'starting',
      currentStage: data.stage,
      statusMessage: data.message,
      statusHistory: [
        ...prev.statusHistory,
        {
          stage: data.stage,
          message: data.message,
          timestamp: data.timestamp,
        },
      ],
    }));
  }, []);

  // Handle agent started event
  const handleStarted = useCallback((data: ContainerAgentStarted) => {
    setState((prev) => ({
      ...prev,
      status: 'starting',
      model: data.model,
      maxTurns: data.maxTurns,
      remainingTurns: data.maxTurns,
      sandboxProvider: data.sandboxProvider,
      sandboxContainerId: data.sandboxContainerId,
      startedAt: data.timestamp,
    }));
  }, []);

  // Handle token streaming
  const handleToken = useCallback((data: ContainerAgentToken) => {
    setIsStreaming(true);
    setState((prev) => ({
      ...prev,
      status: 'running',
      streamedText: data.accumulated,
    }));
  }, []);

  // Handle turn update
  const handleTurn = useCallback((data: ContainerAgentTurn) => {
    setState((prev) => ({
      ...prev,
      status: 'running',
      currentTurn: data.turn,
      remainingTurns: data.remaining,
    }));
  }, []);

  // Handle tool start
  const handleToolStart = useCallback((data: ContainerAgentToolStart) => {
    setState((prev) => {
      // Check if tool already exists to prevent duplicates on reconnection
      const existingIndex = prev.toolExecutions.findIndex((t) => t.toolId === data.toolId);
      if (existingIndex >= 0) {
        // Tool already exists, don't add duplicate
        return prev;
      }
      // Add new tool
      return {
        ...prev,
        toolExecutions: [
          ...prev.toolExecutions,
          {
            toolId: data.toolId,
            toolName: data.toolName,
            input: data.input,
            status: 'running',
            startedAt: data.timestamp,
          },
        ],
      };
    });
  }, []);

  // Handle tool result
  const handleToolResult = useCallback((data: ContainerAgentToolResult) => {
    setState((prev) => ({
      ...prev,
      toolExecutions: prev.toolExecutions.map((tool) =>
        tool.toolId === data.toolId
          ? {
              ...tool,
              result: data.result,
              isError: data.isError,
              durationMs: data.durationMs,
              status: data.isError ? 'error' : 'complete',
              completedAt: data.timestamp,
            }
          : tool
      ),
    }));
  }, []);

  // Handle message
  const handleMessage = useCallback(
    (data: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }) => {
      setIsStreaming(false);
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, data],
        // Clear streamed text after message is complete
        streamedText: '',
      }));
    },
    []
  );

  // Handle completion
  const handleComplete = useCallback((data: ContainerAgentComplete) => {
    setIsStreaming(false);
    setState((prev) => ({
      ...prev,
      status:
        data.status === 'completed'
          ? 'completed'
          : data.status === 'cancelled'
            ? 'cancelled'
            : 'error',
      result: data.result,
      completedAt: data.timestamp,
    }));
  }, []);

  // Handle error
  const handleError = useCallback((data: ContainerAgentError) => {
    setIsStreaming(false);
    setState((prev) => ({
      ...prev,
      status: 'error',
      error: data.error,
      errorCode: data.code,
      completedAt: data.timestamp,
    }));
  }, []);

  // Handle cancelled
  const handleCancelled = useCallback((data: { turnCount: number; timestamp: number }) => {
    setIsStreaming(false);
    setState((prev) => ({
      ...prev,
      status: 'cancelled',
      completedAt: data.timestamp,
    }));
  }, []);

  // Handle plan ready
  const handlePlanReady = useCallback((data: ContainerAgentPlanReady) => {
    setIsStreaming(false);
    setState((prev) => ({
      ...prev,
      status: 'plan_ready',
      plan: data.plan,
      result: 'Plan ready for review',
      completedAt: data.timestamp,
    }));
  }, []);

  // Handle worktree info
  const handleWorktree = useCallback((data: ContainerAgentWorktree) => {
    setState((prev) => ({
      ...prev,
      branch: data.branch,
    }));
  }, []);

  // Handle file changed
  const handleFileChanged = useCallback((data: ContainerAgentFileChanged) => {
    setState((prev) => {
      // Deduplicate by path — update existing entry for the same file
      const existingIndex = prev.fileChanges.findIndex((f) => f.path === data.path);
      if (existingIndex >= 0) {
        const updated = [...prev.fileChanges];
        updated[existingIndex] = {
          path: data.path,
          action: data.action,
          toolName: data.toolName,
          additions: data.additions,
          deletions: data.deletions,
          timestamp: data.timestamp,
        };
        return { ...prev, fileChanges: updated };
      }
      return {
        ...prev,
        fileChanges: [
          ...prev.fileChanges,
          {
            path: data.path,
            action: data.action,
            toolName: data.toolName,
            additions: data.additions,
            deletions: data.deletions,
            timestamp: data.timestamp,
          },
        ],
      };
    });
  }, []);

  // Subscribe to session events
  useEffect(() => {
    if (!sessionId) {
      setState(initialState);
      setConnectionState('disconnected');
      return;
    }

    setConnectionState('connecting');

    const callbacks: SessionCallbacks = {
      onContainerAgentStatus: (event) => handleStatus(event.data),
      onContainerAgentStarted: (event) => handleStarted(event.data),
      onContainerAgentToken: (event) => handleToken(event.data),
      onContainerAgentTurn: (event) => handleTurn(event.data),
      onContainerAgentToolStart: (event) => handleToolStart(event.data),
      onContainerAgentToolResult: (event) => handleToolResult(event.data),
      onContainerAgentMessage: (event) => handleMessage(event.data),
      onContainerAgentComplete: (event) => handleComplete(event.data),
      onContainerAgentError: (event) => handleError(event.data),
      onContainerAgentCancelled: (event) => handleCancelled(event.data),
      onContainerAgentPlanReady: (event) => handlePlanReady(event.data),
      onContainerAgentWorktree: (event) => handleWorktree(event.data),
      onContainerAgentFileChanged: (event) => handleFileChanged(event.data),
      onError: (error) => {
        console.error('[useContainerAgent] Stream error:', error);
        setConnectionState('disconnected');
      },
      onReconnect: () => {
        console.log('[useContainerAgent] Reconnected to session stream');
        setConnectionState('connected');
      },
      onDisconnect: () => {
        console.log('[useContainerAgent] Disconnected from session stream');
        setConnectionState('reconnecting');
      },
    };

    const subscription = subscribeToSession(sessionId, callbacks);
    subscriptionRef.current = subscription;
    setConnectionState('connected');

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [
    sessionId,
    handleStatus,
    handleStarted,
    handleToken,
    handleTurn,
    handleToolStart,
    handleToolResult,
    handleMessage,
    handleComplete,
    handleError,
    handleCancelled,
    handlePlanReady,
    handleWorktree,
    handleFileChanged,
  ]);

  return { state, connectionState, isStreaming };
}
