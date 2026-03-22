/**
 * Session Event Schemas
 *
 * Zod schemas for session events with type inference.
 *
 * @module lib/sessions/schema
 */

import { z } from 'zod';

/**
 * Token chunk schema - streaming text from agent
 */
export const chunkSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  text: z.string(),
  turn: z.number().optional(),
  timestamp: z.number(),
});

/**
 * Tool call schema - agent tool invocations
 */
export const toolCallSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
  duration: z.number().optional(),
  timestamp: z.number(),
});

/**
 * Presence schema - who's watching the session
 */
export const presenceSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  cursor: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  lastSeen: z.number(),
  joinedAt: z.number().optional(),
});

/**
 * Terminal I/O schema - interactive input/output
 */
export const terminalSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.enum(['input', 'output', 'error']),
  data: z.string(),
  source: z.enum(['user', 'agent', 'system']).optional(),
  timestamp: z.number(),
});

/**
 * Workflow events schema - approval workflow
 */
export const workflowSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  type: z.enum([
    'approval:requested',
    'approval:approved',
    'approval:rejected', // AE-012: Deprecated, kept for backward compat with persisted events. Use 'agent:resumed' instead.
    'agent:resumed',
    'worktree:created',
    'worktree:merged',
    'worktree:removed',
  ]),
  payload: z.record(z.string(), z.unknown()),
  actor: z.string().optional(),
  timestamp: z.number(),
});

/**
 * Agent state schema - overall agent status
 */
export const agentStateSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']),
  taskId: z.string().min(1).optional(),
  turn: z.number().optional(),
  progress: z.number().optional(),
  currentTool: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.number(),
});

/**
 * Derived message schema - aggregated from chunks
 */
export const messageSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string(),
  turn: z.number(),
  timestamp: z.number(),
});

// Export inferred types
export type ChunkEvent = z.infer<typeof chunkSchema>;
export type ToolCallEvent = z.infer<typeof toolCallSchema>;
export type PresenceEvent = z.infer<typeof presenceSchema>;
export type TerminalEvent = z.infer<typeof terminalSchema>;
export type WorkflowEvent = z.infer<typeof workflowSchema>;
export type AgentStateEvent = z.infer<typeof agentStateSchema>;
export type Message = z.infer<typeof messageSchema>;

/**
 * Union of all session events with channel discriminator
 */
export type SessionEvent =
  | { channel: 'chunks'; data: ChunkEvent }
  | { channel: 'toolCalls'; data: ToolCallEvent }
  | { channel: 'presence'; data: PresenceEvent }
  | { channel: 'terminal'; data: TerminalEvent }
  | { channel: 'workflow'; data: WorkflowEvent }
  | { channel: 'agentState'; data: AgentStateEvent };
