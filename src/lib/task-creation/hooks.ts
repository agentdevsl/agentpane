import { eq } from '@tanstack/db';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import { getTaskCreationToolsAsync } from '@/lib/constants/tools';
import { useCollectionQuery } from '@/lib/db/use-collection-query';
import { taskCreationMessagesCollection, taskCreationSessionsCollection } from './collections';
import type {
  PendingQuestions,
  SessionStatus,
  TaskCreationMessage,
  TaskCreationSession,
  TaskSuggestion,
} from './schema';
import {
  addUserMessage,
  createTaskCreationSession,
  resetTaskCreationSession,
  stopTaskCreationSync,
  syncTaskCreationToCollections,
} from './sync';

// ============================================================================
// Types
// ============================================================================

export interface UseTaskCreationState {
  /** Current session ID */
  sessionId: string | null;
  /** Current session status */
  status: SessionStatus;
  /** All messages in the conversation */
  messages: TaskCreationMessage[];
  /** Content being streamed (not yet finalized) */
  streamingContent: string;
  /** Whether we're currently streaming a response */
  isStreaming: boolean;
  /** Current task suggestion if available */
  suggestion: TaskSuggestion | null;
  /** Pending clarifying questions */
  pendingQuestions: PendingQuestions | null;
  /** ID of the created task (after accept) */
  createdTaskId: string | null;
  /** Error message if any (from session or local operations) */
  error: string | null;
  /** Local error from hook operations (separate from session errors) */
  localError: string | null;
  /** Whether an answer submission is in progress (prevents double-click) */
  isAnswering: boolean;
}

export interface UseTaskCreationActions {
  /** Start a new conversation */
  startConversation: () => Promise<void>;
  /** Send a message */
  sendMessage: (content: string) => Promise<void>;
  /** Accept the current suggestion and create a task */
  acceptSuggestion: (
    overrides?: Partial<TaskSuggestion>
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Answer clarifying questions (supports both single and multi-select) */
  answerQuestions: (answers: Record<string, string | string[]>) => Promise<void>;
  /** Skip clarifying questions */
  skipQuestions: () => Promise<void>;
  /** Cancel the session */
  cancel: () => Promise<void>;
  /** Reset the state */
  reset: () => void;
  /** Clear any local error */
  clearLocalError: () => void;
}

export type UseTaskCreationReturn = UseTaskCreationState & UseTaskCreationActions;

// ============================================================================
// Hooks
// ============================================================================

/**
 * Get a task creation session by ID using live query
 */
export function useTaskCreationSession(sessionId: string | null): TaskCreationSession | null {
  // Use empty string when no sessionId to create a valid query that returns nothing
  const queryId = sessionId ?? '';

  const { data } = useCollectionQuery<TaskCreationSession>(
    (q) =>
      q
        .from({ sessions: taskCreationSessionsCollection })
        .where(({ sessions }: { sessions: TaskCreationSession }) => eq(sessions.id, queryId)),
    [queryId]
  );

  return data?.[0] ?? null;
}

/**
 * Get all messages for a task creation session using live query
 */
export function useTaskCreationMessages(sessionId: string | null): TaskCreationMessage[] {
  // Use empty string when no sessionId to create a valid query that returns nothing
  const queryId = sessionId ?? '';

  const { data } = useCollectionQuery<TaskCreationMessage>(
    (q) =>
      q
        .from({ messages: taskCreationMessagesCollection })
        .where(({ messages }: { messages: TaskCreationMessage }) =>
          eq(messages.sessionId, queryId)
        ),
    [queryId]
  );

  // Sort by timestamp
  return useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => a.timestamp - b.timestamp);
  }, [data]);
}

/**
 * Main hook for task creation functionality
 * Manages session lifecycle, API calls, and TanStack DB synchronization
 */
export function useTaskCreation(projectId: string): UseTaskCreationReturn {
  // Local state for session ID (only thing we need to track locally)
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Local error state for operation failures (separate from session errors)
  const [localError, setLocalError] = useState<string | null>(null);
  // Track answer submission to prevent double-clicks
  const [isAnswering, setIsAnswering] = useState(false);
  const isAnsweringRef = useRef(false);
  // Track which questions ID we submitted answers for (to know when to clear loading state)
  const submittedQuestionsIdRef = useRef<string | null>(null);

  // Get session and messages from TanStack DB (reactive)
  const session = useTaskCreationSession(sessionId);
  const messages = useTaskCreationMessages(sessionId);

  // Derive state from session
  const status: SessionStatus = session?.status ?? 'idle';
  const streamingContent = session?.streamingContent ?? '';
  const isStreaming = session?.isStreaming ?? false;
  const suggestion = session?.suggestion ?? null;
  const pendingQuestions = session?.pendingQuestions ?? null;
  const createdTaskId = session?.createdTaskId ?? null;
  const error = session?.error ?? null;

  // Clear isAnswering when questions change or streaming starts
  // This handles the gap between API response and SSE stream starting
  useEffect(() => {
    if (!submittedQuestionsIdRef.current) return;

    // Clear loading state when:
    // 1. Questions ID changed (new questions or questions cleared)
    // 2. Streaming has started (AI is responding)
    const questionsChanged = pendingQuestions?.id !== submittedQuestionsIdRef.current;
    const streamStarted = isStreaming;

    if (questionsChanged || streamStarted) {
      submittedQuestionsIdRef.current = null;
      isAnsweringRef.current = false;
      setIsAnswering(false);
    }
  }, [pendingQuestions?.id, isStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionId) {
        stopTaskCreationSync(sessionId);
      }
    };
  }, [sessionId]);

  // Start a new conversation
  const startConversation = useCallback(async () => {
    // Clear any previous local error
    setLocalError(null);

    // Get configured tools from API (falls back to localStorage/defaults)
    const allowedTools = await getTaskCreationToolsAsync();

    // Call API to start session with configured tools
    const result = await apiClient.taskCreation.start(projectId, allowedTools);

    if (!result.ok) {
      console.error('[useTaskCreation] Failed to start conversation:', result.error);
      setLocalError(result.error.message || 'Failed to start conversation');
      return;
    }

    const newSessionId = result.data.sessionId;

    // Create session in TanStack DB collection
    createTaskCreationSession(newSessionId, projectId);

    // Start syncing SSE events to collection
    const streamUrl = apiClient.taskCreation.getStreamUrl(newSessionId);
    syncTaskCreationToCollections(newSessionId, streamUrl);

    // Update local state
    setSessionId(newSessionId);
    console.log('[useTaskCreation] Started session:', { sessionId: newSessionId, projectId });
  }, [projectId]);

  // Send a message
  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId) {
        console.error('[useTaskCreation] No active session');
        setLocalError('No active session');
        return;
      }

      // Clear any previous local error
      setLocalError(null);

      // Add user message to collection immediately (optimistic)
      addUserMessage(sessionId, content);

      // Send to API
      const result = await apiClient.taskCreation.sendMessage(sessionId, content);

      if (!result.ok) {
        console.error('[useTaskCreation] Failed to send message:', result.error);
        // Set local error - SSE may also send an error event but this ensures immediate feedback
        setLocalError(result.error.message || 'Failed to send message');
      }
    },
    [sessionId]
  );

  // Accept suggestion and create task
  const acceptSuggestion = useCallback(
    async (overrides?: Partial<TaskSuggestion>): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) {
        console.error('[useTaskCreation] No active session');
        return { ok: false, error: 'No active session' };
      }

      // When overrides contain all required fields (title, description), we don't need
      // the TanStack DB suggestion - the API can create the task from overrides alone
      const hasCompleteOverrides = overrides?.title && overrides?.description;
      if (!suggestion && !hasCompleteOverrides) {
        console.error('[useTaskCreation] No suggestion available and overrides incomplete');
        return { ok: false, error: 'No suggestion available' };
      }

      console.log('[useTaskCreation] Accepting suggestion:', { sessionId, overrides, suggestion });
      const result = await apiClient.taskCreation.accept(sessionId, overrides);

      if (!result.ok) {
        console.error('[useTaskCreation] Failed to accept suggestion:', result.error);
        return { ok: false, error: result.error.message };
      }

      console.log('[useTaskCreation] Accept API succeeded:', result.data);
      // Completion will be handled via SSE event
      return { ok: true };
    },
    [sessionId, suggestion]
  );

  // Answer clarifying questions (supports both single and multi-select)
  const answerQuestions = useCallback(
    async (answers: Record<string, string | string[]>) => {
      if (!sessionId || !pendingQuestions) {
        console.error('[useTaskCreation] No active session or pending questions');
        setLocalError('No active session or pending questions');
        return;
      }

      // Prevent double-submission using a ref (not state) to avoid the async render
      // gap where React state hasn't updated yet between rapid calls
      if (isAnsweringRef.current) {
        console.log('[useTaskCreation] Answer already in progress, ignoring');
        return;
      }

      // Clear any previous local error and mark as submitting
      setLocalError(null);
      isAnsweringRef.current = true;
      setIsAnswering(true);
      // Track which questions we're answering (effect will clear loading when this changes)
      submittedQuestionsIdRef.current = pendingQuestions.id;

      try {
        console.log('[useTaskCreation] Answering questions:', {
          sessionId,
          questionsId: pendingQuestions.id,
          answers,
        });
        const result = await apiClient.taskCreation.answerQuestions(
          sessionId,
          pendingQuestions.id,
          answers
        );

        if (!result.ok) {
          console.error('[useTaskCreation] Failed to answer questions:', result.error);

          // If session is stale or missing, reset and let user start fresh
          if (
            result.error.code === 'INVALID_QUESTIONS_ID' ||
            result.error.code === 'SESSION_NOT_FOUND' ||
            result.error.message?.includes('Questions ID does not match') ||
            result.error.message?.includes('Session not found')
          ) {
            console.log('[useTaskCreation] Session state mismatch - resetting');
            resetTaskCreationSession(sessionId);
            setSessionId(null);
            setLocalError('Session expired. Please start a new conversation.');
            // Clear loading state on error so user can retry
            isAnsweringRef.current = false;
            setIsAnswering(false);
            return;
          }

          // Set local error - SSE may also send an error event but this ensures immediate feedback
          setLocalError(result.error.message || 'Failed to submit answers');
          // Clear loading state on error so user can retry
          isAnsweringRef.current = false;
          setIsAnswering(false);
        }
        // On success, don't clear isAnswering here - let the useEffect handle it
        // when pendingQuestions changes or isStreaming becomes true
      } catch (error) {
        // Handle unexpected errors
        console.error('[useTaskCreation] Unexpected error answering questions:', error);
        setLocalError('An unexpected error occurred');
        isAnsweringRef.current = false;
        setIsAnswering(false);
      }
    },
    [sessionId, pendingQuestions]
  );

  // Skip clarifying questions
  const skipQuestions = useCallback(async () => {
    if (!sessionId) {
      console.error('[useTaskCreation] No active session');
      setLocalError('No active session');
      return;
    }

    if (isAnsweringRef.current) {
      console.log('[useTaskCreation] Skip already in progress, ignoring');
      return;
    }

    // Clear any previous local error and set loading state
    setLocalError(null);
    isAnsweringRef.current = true;
    setIsAnswering(true);
    submittedQuestionsIdRef.current = pendingQuestions?.id ?? null;

    try {
      const result = await apiClient.taskCreation.skipQuestions(sessionId);

      if (!result.ok) {
        console.error('[useTaskCreation] Failed to skip questions:', result.error);
        setLocalError(result.error.message || 'Failed to skip questions');
        isAnsweringRef.current = false;
        setIsAnswering(false);
      }
      // On success, let the useEffect clear isAnswering when pendingQuestions changes or streaming starts
    } catch (error) {
      console.error('[useTaskCreation] Unexpected error skipping questions:', error);
      setLocalError('An unexpected error occurred');
      isAnsweringRef.current = false;
      setIsAnswering(false);
    }
  }, [sessionId, pendingQuestions?.id]);

  // Cancel session
  const cancel = useCallback(async () => {
    if (!sessionId) {
      console.error('[useTaskCreation] No active session to cancel');
      return;
    }

    // Clear any previous local error
    setLocalError(null);

    const result = await apiClient.taskCreation.cancel(sessionId);

    if (!result.ok) {
      console.error('[useTaskCreation] Failed to cancel:', result.error);
      // Set local error - SSE may also send an error event but this ensures immediate feedback
      setLocalError(result.error.message || 'Failed to cancel session');
    }
  }, [sessionId]);

  // Reset state
  const reset = useCallback(() => {
    if (sessionId) {
      resetTaskCreationSession(sessionId);
    }
    setSessionId(null);
    setLocalError(null);
    setIsAnswering(false);
    isAnsweringRef.current = false;
  }, [sessionId]);

  // Clear local error
  const clearLocalError = useCallback(() => {
    setLocalError(null);
  }, []);

  return {
    // State (from TanStack DB)
    sessionId,
    status,
    messages,
    streamingContent,
    isStreaming,
    suggestion,
    pendingQuestions,
    createdTaskId,
    error,
    localError,
    isAnswering,
    // Actions
    startConversation,
    sendMessage,
    acceptSuggestion,
    answerQuestions,
    skipQuestions,
    cancel,
    reset,
    clearLocalError,
  };
}
