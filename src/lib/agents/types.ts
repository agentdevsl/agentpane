import { z } from 'zod';

export const agentMessageSchema = z.discriminatedUnion('type', [
  // Partial text being streamed
  z.object({
    type: z.literal('stream_event'),
    event: z
      .object({
        type: z.string(),
        delta: z
          .object({
            text: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  // Complete assistant response
  z.object({
    type: z.literal('assistant_message'),
    content: z.array(
      z.object({
        type: z.literal('text'),
        text: z.string(),
      })
    ),
  }),
  // Tool use request
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  // Tool result
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.array(
      z.object({
        type: z.enum(['text', 'image']),
        text: z.string().optional(),
      })
    ),
  }),
  // Tool use summary (SDK v0.2.76+)
  z.object({
    type: z.literal('tool_use_summary'),
    summary: z.string(),
    preceding_tool_use_ids: z.array(z.string()),
  }),
  // Final result
  z.object({
    type: z.literal('result'),
    result: z.string(),
  }),
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;

export interface AgentQueryOptions {
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  systemPrompt?: string;
  cwd: string;
  hooks?: AgentHooks;
}

export interface AgentHooks {
  PreToolUse: PreToolUseHook[];
  PostToolUse: PostToolUseHook[];
}

export interface PreToolUseHook {
  hooks: Array<(input: PreToolUseInput) => Promise<PreToolUseResult>>;
}

export interface PostToolUseHook {
  hooks: Array<(input: PostToolUseInput) => Promise<Record<string, never>>>;
}

export interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PreToolUseResult {
  decision?: 'block';
  message?: string;
}

export interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: ToolResponse;
  duration_ms: number;
}

export interface ToolResponse {
  content: Array<{ type: 'text' | 'image'; text?: string }>;
  is_error?: boolean;
}

export interface ToolContext {
  cwd: string;
}
