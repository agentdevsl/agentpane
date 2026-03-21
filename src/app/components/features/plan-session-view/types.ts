/**
 * Types for the Plan Session View components
 */

import type {
  InteractionQuestion,
  PlanSession,
  PlanSessionStatus,
  PlanTurn,
  PlanTurnRole,
  UserInteraction,
} from '@/lib/plan-mode/types';

// Re-export types from plan-mode for convenience
export type {
  InteractionQuestion,
  PlanSession,
  PlanSessionStatus,
  PlanTurn,
  PlanTurnRole,
  UserInteraction,
};

/**
 * SSE event types received from the plan stream
 */
export type PlanStreamEventType =
  | 'connected'
  | 'plan:started'
  | 'plan:turn'
  | 'plan:token'
  | 'plan:interaction'
  | 'plan:completed'
  | 'plan:error'
  | 'plan:cancelled';

/**
 * Base stream event structure
 */
export interface PlanStreamEvent {
  id: string;
  type: PlanStreamEventType;
  timestamp: number;
  data: unknown;
}

/**
 * Plan started event data
 */
export interface PlanStartedEventData {
  sessionId: string;
  taskId: string;
  codespaceId: string;
}

/**
 * Plan turn event data
 */
export interface PlanTurnEventData {
  sessionId: string;
  turnId: string;
  role: PlanTurnRole;
  content: string;
}

/**
 * Plan token event data (streaming)
 */
export interface PlanTokenEventData {
  sessionId: string;
  delta: string;
  accumulated: string;
}

/**
 * Plan interaction event data
 */
export interface PlanInteractionEventData {
  sessionId: string;
  interactionId: string;
  questions: InteractionQuestion[];
}

/**
 * Plan completed event data
 */
export interface PlanCompletedEventData {
  sessionId: string;
  issueUrl?: string;
  issueNumber?: number;
}

/**
 * Plan error event data
 */
export interface PlanErrorEventData {
  sessionId: string;
  error: string;
  code?: string;
}

/**
 * Display message in the stream panel
 */
export interface StreamMessage {
  id: string;
  role: PlanTurnRole;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  interaction?: UserInteraction;
}

/**
 * Plan session view state
 */
export interface PlanSessionState {
  session: PlanSession | null;
  messages: StreamMessage[];
  streamingContent: string;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  pendingInteraction: UserInteraction | null;
  completionInfo: {
    issueUrl?: string;
    issueNumber?: number;
  } | null;
}

/**
 * Plan session view actions
 */
export type PlanSessionAction =
  | { type: 'SET_SESSION'; session: PlanSession }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'STREAM_START' }
  | { type: 'STREAM_TOKEN'; delta: string; accumulated: string }
  | { type: 'STREAM_END'; content: string }
  | { type: 'ADD_TURN'; turn: PlanTurn }
  | { type: 'SET_INTERACTION'; interaction: UserInteraction | null }
  | { type: 'SET_COMPLETED'; issueUrl?: string; issueNumber?: number }
  | { type: 'RESET' };

/**
 * Props for PlanSessionView component
 */
export interface PlanSessionViewProps {
  taskId: string;
  codespaceId: string;
  onSessionEnd?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Props for PlanStreamPanel component
 */
export interface PlanStreamPanelProps {
  messages: StreamMessage[];
  streamingContent: string;
  isStreaming: boolean;
}

/**
 * Props for PlanInputArea component
 */
export interface PlanInputAreaProps {
  onSubmit: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Props for PlanInteraction component
 */
export interface PlanInteractionProps {
  interaction: UserInteraction;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
}
