/**
 * Shared API response types used across the API client.
 * These types are derived from the domain types to ensure consistency.
 */

import type { TaskPriority } from '@/db/schema';

/**
 * API error codes for categorizing different error types
 */
export const API_ERROR_CODES = {
  /** Request was cancelled via AbortController */
  REQUEST_ABORTED: 'REQUEST_ABORTED',
  /** Network-level failure (connection refused, DNS error, CORS, etc.) */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** Generic fetch error */
  FETCH_ERROR: 'FETCH_ERROR',
  /** Response body was not valid JSON */
  PARSE_ERROR: 'PARSE_ERROR',
  /** Server returned an error response */
  SERVER_ERROR: 'SERVER_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/**
 * Task suggestion from AI task creation
 */
export interface TaskSuggestion {
  title: string;
  description: string;
  labels: string[];
  priority: TaskPriority;
}

/**
 * Task creation session status
 */
export type TaskCreationStatus = 'active' | 'completed' | 'cancelled';

/**
 * Task creation session state
 */
export interface TaskCreationSession {
  sessionId: string;
  codespaceId: string;
  status: TaskCreationStatus;
  createdAt: string;
}

/**
 * Task creation message response
 */
export interface TaskCreationMessageResponse {
  sessionId: string;
  status: TaskCreationStatus;
  messageCount: number;
  hasSuggestion: boolean;
  suggestion: TaskSuggestion | null;
}

/**
 * Task creation accept response
 */
export interface TaskCreationAcceptResponse {
  taskId: string;
  sessionId: string;
  status: TaskCreationStatus;
}

/**
 * Plan session stream event types
 */
export type PlanStreamEventType =
  | 'connected'
  | 'plan:started'
  | 'plan:turn'
  | 'plan:token'
  | 'plan:interaction'
  | 'plan:completed'
  | 'plan:error'
  | 'plan:cancelled'
  | 'error';

/**
 * Re-export domain types for convenience
 */
export type { TaskPriority } from '@/db/schema';
export type { PlanSession, PlanSessionStatus } from '@/lib/plan-mode/types';
