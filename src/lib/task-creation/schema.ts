import { z } from 'zod';

// ============================================================================
// Task Creation Schemas
// ============================================================================

/**
 * Task priority levels
 */
export const taskPrioritySchema = z.enum(['high', 'medium', 'low']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

/**
 * Task suggestion from AI
 */
export const taskSuggestionSchema = z.object({
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  priority: taskPrioritySchema,
});
export type TaskSuggestion = z.infer<typeof taskSuggestionSchema>;

/**
 * Clarifying question option
 */
export const clarifyingQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type ClarifyingQuestionOption = z.infer<typeof clarifyingQuestionOptionSchema>;

/**
 * Clarifying question
 */
export const clarifyingQuestionSchema = z.object({
  header: z.string(),
  question: z.string(),
  options: z.array(clarifyingQuestionOptionSchema),
  multiSelect: z.boolean().optional().default(false),
});
export type ClarifyingQuestion = z.infer<typeof clarifyingQuestionSchema>;

/**
 * Pending questions state
 */
export const pendingQuestionsSchema = z.object({
  id: z.string(),
  questions: z.array(clarifyingQuestionSchema),
  round: z.number(),
  totalAsked: z.number(),
  maxQuestions: z.number(),
});
export type PendingQuestions = z.infer<typeof pendingQuestionsSchema>;

/**
 * Task creation message
 */
export const taskCreationMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.number(),
});
export type TaskCreationMessage = z.infer<typeof taskCreationMessageSchema>;

/**
 * Task creation session status
 */
export const sessionStatusSchema = z.enum([
  'idle',
  'connecting',
  'active',
  'waiting_user',
  'completed',
  'cancelled',
  'error',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * Task creation session state
 */
export const taskCreationSessionSchema = z.object({
  id: z.string(),
  codespaceId: z.string(),
  status: sessionStatusSchema,
  suggestion: taskSuggestionSchema.nullable(),
  pendingQuestions: pendingQuestionsSchema.nullable(),
  createdTaskId: z.string().nullable(),
  error: z.string().nullable(),
  isStreaming: z.boolean(),
  streamingContent: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskCreationSession = z.infer<typeof taskCreationSessionSchema>;

/**
 * Token streaming event
 */
export const tokenEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  delta: z.string(),
  timestamp: z.number(),
});
export type TokenEvent = z.infer<typeof tokenEventSchema>;
