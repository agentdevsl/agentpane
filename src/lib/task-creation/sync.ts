import { createId } from '@paralleldrive/cuid2';
import { createLogger } from '../logging/logger.js';

const log = createLogger('TaskCreationSync');

import {
  clearTaskCreationSession,
  taskCreationMessagesCollection,
  taskCreationSessionsCollection,
} from './collections';
import type {
  PendingQuestions,
  TaskCreationMessage,
  TaskCreationSession,
  TaskSuggestion,
} from './schema';

// ============================================================================
// Types
// ============================================================================

interface TaskCreationEventData {
  sessionId: string;
  [key: string]: unknown;
}

interface TokenEventData extends TaskCreationEventData {
  delta: string;
}

interface MessageEventData extends TaskCreationEventData {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

interface QuestionsEventData extends TaskCreationEventData {
  questions: PendingQuestions;
}

interface SuggestionEventData extends TaskCreationEventData {
  suggestion: TaskSuggestion;
}

interface CompletedEventData extends TaskCreationEventData {
  taskId: string;
}

interface ErrorEventData extends TaskCreationEventData {
  error: string;
  code?: string;
}

interface ProcessingEventData extends TaskCreationEventData {
  message?: string;
}

type TaskCreationEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'task-creation:token'; data: TokenEventData }
  | { type: 'task-creation:message'; data: MessageEventData }
  | { type: 'task-creation:questions'; data: QuestionsEventData }
  | { type: 'task-creation:suggestion'; data: SuggestionEventData }
  | { type: 'task-creation:processing'; data: ProcessingEventData }
  | { type: 'task-creation:completed'; data: CompletedEventData }
  | { type: 'task-creation:cancelled'; data: TaskCreationEventData }
  | { type: 'task-creation:error'; data: ErrorEventData };

// ============================================================================
// Active Syncs Tracking
// ============================================================================

const activeSyncs = new Map<string, EventSource>();

// ============================================================================
// Sync Functions
// ============================================================================

/**
 * Start syncing a task creation session to TanStack DB collections
 * @param sessionId The session ID to sync
 * @param streamUrl The SSE stream URL
 * @returns Cleanup function to stop syncing
 */
export function syncTaskCreationToCollections(sessionId: string, streamUrl: string): () => void {
  // Check if already syncing
  if (activeSyncs.has(sessionId)) {
    return () => stopTaskCreationSync(sessionId);
  }

  // Create EventSource for SSE
  const eventSource = new EventSource(streamUrl);
  activeSyncs.set(sessionId, eventSource);

  eventSource.onopen = () => {
    // Connection established — no action needed, events will flow via onmessage
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as TaskCreationEvent;
      handleTaskCreationEvent(sessionId, data);
    } catch (error) {
      log.debug('Failed to parse task creation SSE event', { error });
    }
  };

  eventSource.onerror = (_error) => {
    // Update session status to error if the connection is closed
    // Also clear pendingQuestions since server session is likely lost
    if (eventSource.readyState === EventSource.CLOSED) {
      updateSession(sessionId, {
        status: 'error',
        error: 'Connection lost. Please start a new conversation.',
        isStreaming: false,
        pendingQuestions: null,
      });
    }
  };

  return () => stopTaskCreationSync(sessionId);
}

/**
 * Stop syncing a task creation session
 */
export function stopTaskCreationSync(sessionId: string): void {
  const eventSource = activeSyncs.get(sessionId);
  if (eventSource) {
    eventSource.close();
    activeSyncs.delete(sessionId);
  }
}

/**
 * Check if a session is currently syncing
 */
export function isSessionSyncing(sessionId: string): boolean {
  return activeSyncs.has(sessionId);
}

// ============================================================================
// Event Handlers
// ============================================================================

function handleTaskCreationEvent(sessionId: string, event: TaskCreationEvent): void {
  switch (event.type) {
    case 'connected':
      // Connection established, update session status
      updateSession(sessionId, { status: 'active' });
      break;

    case 'task-creation:token':
      handleTokenEvent(sessionId, event.data);
      break;

    case 'task-creation:message':
      handleMessageEvent(sessionId, event.data);
      break;

    case 'task-creation:questions':
      handleQuestionsEvent(sessionId, event.data);
      break;

    case 'task-creation:suggestion':
      handleSuggestionEvent(sessionId, event.data);
      break;

    case 'task-creation:completed':
      handleCompletedEvent(sessionId, event.data);
      break;

    case 'task-creation:cancelled':
      handleCancelledEvent(sessionId);
      break;

    case 'task-creation:error':
      handleErrorEvent(sessionId, event.data);
      break;

    case 'task-creation:processing':
      // Answers accepted, clear pending questions and show processing state
      updateSession(sessionId, {
        pendingQuestions: null,
        isStreaming: true,
      });
      break;

    default:
  }
}

function handleTokenEvent(sessionId: string, data: TokenEventData): void {
  // Clear pendingQuestions when streaming starts (fallback if processing event was missed)
  // This makes the UI more resilient to event ordering issues
  if (taskCreationSessionsCollection.has(sessionId)) {
    taskCreationSessionsCollection.update(sessionId, (draft) => {
      draft.isStreaming = true;
      draft.streamingContent = (draft.streamingContent || '') + data.delta;
      draft.pendingQuestions = null; // Clear questions when AI starts responding
      draft.updatedAt = Date.now();
    });
  }
}

function handleMessageEvent(sessionId: string, data: MessageEventData): void {
  // Add message to collection
  const message: TaskCreationMessage = {
    id: data.messageId,
    sessionId,
    role: data.role,
    content: data.content,
    timestamp: Date.now(),
  };

  // Check if message already exists
  if (!taskCreationMessagesCollection.has(message.id)) {
    taskCreationMessagesCollection.insert(message);
  }

  // Update session streaming state when assistant message received
  // Note: Don't change status here - let questions/suggestion events handle status changes
  if (data.role === 'assistant') {
    updateSession(sessionId, {
      isStreaming: false,
      streamingContent: '',
    });
  }
}

function handleQuestionsEvent(sessionId: string, data: QuestionsEventData): void {
  updateSession(sessionId, {
    status: 'waiting_user',
    pendingQuestions: data.questions,
    isStreaming: false,
    streamingContent: '',
  });
}

function handleSuggestionEvent(sessionId: string, data: SuggestionEventData): void {
  updateSession(sessionId, {
    status: 'active', // No longer waiting for user - showing suggestion
    suggestion: data.suggestion,
    pendingQuestions: null,
    isStreaming: false,
  });
}

function handleCompletedEvent(sessionId: string, data: CompletedEventData): void {
  updateSession(sessionId, {
    status: 'completed',
    createdTaskId: data.taskId,
    isStreaming: false,
  });

  // Stop syncing after completion
  stopTaskCreationSync(sessionId);
}

function handleCancelledEvent(sessionId: string): void {
  updateSession(sessionId, {
    status: 'cancelled',
    isStreaming: false,
  });

  // Stop syncing after cancellation
  stopTaskCreationSync(sessionId);
}

function handleErrorEvent(sessionId: string, data: ErrorEventData): void {
  updateSession(sessionId, {
    status: 'error',
    error: data.error,
    isStreaming: false,
  });
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Create a new task creation session in the collection
 */
export function createTaskCreationSession(
  sessionId: string,
  codespaceId: string
): TaskCreationSession {
  const session: TaskCreationSession = {
    id: sessionId,
    codespaceId,
    status: 'connecting',
    suggestion: null,
    pendingQuestions: null,
    createdTaskId: null,
    error: null,
    isStreaming: false,
    streamingContent: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  taskCreationSessionsCollection.insert(session);
  return session;
}

/**
 * Update a task creation session in the collection
 */
function updateSession(
  sessionId: string,
  updates: Partial<Omit<TaskCreationSession, 'id' | 'codespaceId' | 'createdAt'>>
): void {
  if (taskCreationSessionsCollection.has(sessionId)) {
    taskCreationSessionsCollection.update(sessionId, (draft) => {
      Object.assign(draft, updates, { updatedAt: Date.now() });
    });
  }
}

/**
 * Add a user message to the collection
 */
export function addUserMessage(sessionId: string, content: string): TaskCreationMessage {
  const message: TaskCreationMessage = {
    id: createId(),
    sessionId,
    role: 'user',
    content,
    timestamp: Date.now(),
  };

  taskCreationMessagesCollection.insert(message);

  // Update session to show streaming state
  updateSession(sessionId, {
    isStreaming: true,
    streamingContent: '',
  });

  return message;
}

/**
 * Reset session state (for retrying or starting over)
 */
export function resetTaskCreationSession(sessionId: string): void {
  stopTaskCreationSync(sessionId);
  clearTaskCreationSession(sessionId);
}
