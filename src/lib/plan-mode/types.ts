import { z } from 'zod';

/**
 * Plan session status
 */
export type PlanSessionStatus = 'active' | 'waiting_user' | 'completed' | 'cancelled';

/**
 * Plan turn role
 */
export type PlanTurnRole = 'user' | 'assistant';

/**
 * User interaction question option
 */
export interface InteractionOption {
  label: string;
  description: string;
}

/**
 * User interaction question
 */
export interface InteractionQuestion {
  question: string;
  header: string;
  options: InteractionOption[];
  multiSelect: boolean;
}

/**
 * User interaction (AskUserQuestion equivalent)
 */
export interface UserInteraction {
  id: string;
  type: 'question';
  questions: InteractionQuestion[];
  answers?: Record<string, string>;
  answeredAt?: string;
}

/**
 * A single turn in a plan conversation
 */
export interface PlanTurn {
  id: string;
  role: PlanTurnRole;
  content: string;
  interaction?: UserInteraction;
  timestamp: string;
}

/**
 * Plan session representing a multi-turn planning conversation
 */
export interface PlanSession {
  id: string;
  taskId: string;
  codespaceId: string;
  status: PlanSessionStatus;
  turns: PlanTurn[];
  githubIssueUrl?: string;
  githubIssueNumber?: number;
  createdAt: string;
  completedAt?: string;
}

/**
 * Input for creating a new plan session
 */
export interface CreatePlanSessionInput {
  taskId: string;
  codespaceId: string;
  initialPrompt: string;
}

/**
 * Input for responding to an interaction
 */
export interface RespondToInteractionInput {
  sessionId: string;
  interactionId: string;
  answers: Record<string, string>;
}

/**
 * Result of completing a plan session
 */
export interface PlanCompletionResult {
  sessionId: string;
  issueUrl?: string;
  issueNumber?: number;
  summary: string;
}

// Re-export OAuthCredentials from shared location for backwards compatibility
export type { OAuthCredentials } from '../../types/credentials.js';

/**
 * Claude API message format
 */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

/**
 * Claude content block types
 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * Claude streaming event types
 */
export type ClaudeStreamEvent =
  | { type: 'message_start'; message: { id: string; model: string } }
  | { type: 'content_block_start'; index: number; content_block: ClaudeContentBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string } }
  | { type: 'message_stop' };

/**
 * Tool definition for AskUserQuestion
 */
export const askUserQuestionTool = {
  name: 'AskUserQuestion',
  description:
    'Ask the user a question with multiple choice options. Use this when you need clarification or user input.',
  input_schema: {
    type: 'object' as const,
    properties: {
      questions: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            question: { type: 'string' as const },
            header: { type: 'string' as const },
            options: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                properties: {
                  label: { type: 'string' as const },
                  description: { type: 'string' as const },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: { type: 'boolean' as const },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
        },
      },
    },
    required: ['questions'],
  },
};

/**
 * Tool definition for CreateGitHubIssue
 */
export const createGitHubIssueTool = {
  name: 'CreateGitHubIssue',
  description:
    'Create a GitHub issue with the plan content. Use this when the plan is finalized and ready to be tracked.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const, description: 'Issue title' },
      body: { type: 'string' as const, description: 'Issue body in markdown' },
      labels: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Labels to apply',
      },
    },
    required: ['title', 'body'],
  },
};

// Zod schemas for validation

export const interactionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

export const interactionQuestionSchema = z.object({
  question: z.string(),
  header: z.string().max(12),
  options: z.array(interactionOptionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});

export const userInteractionSchema = z.object({
  id: z.string(),
  type: z.literal('question'),
  questions: z.array(interactionQuestionSchema).min(1).max(4),
  answers: z.record(z.string(), z.string()).optional(),
  answeredAt: z.string().optional(),
});

export const planTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  interaction: userInteractionSchema.optional(),
  timestamp: z.string(),
});

export const planSessionSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    codespaceId: z.string(),
    status: z.enum(['active', 'waiting_user', 'completed', 'cancelled']),
    turns: z.array(planTurnSchema),
    githubIssueUrl: z.string().optional(),
    githubIssueNumber: z.number().optional(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
  })
  .refine((data) => (data.githubIssueUrl == null) === (data.githubIssueNumber == null), {
    message: 'GitHub issue URL and number must both be present or both absent',
    path: ['githubIssueUrl', 'githubIssueNumber'],
  })
  .refine(
    (data) => {
      // completedAt should only be set for terminal states
      if (data.completedAt && !['completed', 'cancelled'].includes(data.status)) {
        return false;
      }
      return true;
    },
    {
      message: 'completedAt can only be set when status is completed or cancelled',
      path: ['completedAt'],
    }
  );

export const createPlanSessionInputSchema = z.object({
  taskId: z.string(),
  codespaceId: z.string(),
  initialPrompt: z.string(),
});

export const respondToInteractionInputSchema = z.object({
  sessionId: z.string(),
  interactionId: z.string(),
  answers: z.record(z.string(), z.string()),
});

export type InteractionOptionSchema = z.infer<typeof interactionOptionSchema>;
export type InteractionQuestionSchema = z.infer<typeof interactionQuestionSchema>;
export type UserInteractionSchema = z.infer<typeof userInteractionSchema>;
export type PlanTurnSchema = z.infer<typeof planTurnSchema>;
export type PlanSessionSchema = z.infer<typeof planSessionSchema>;
