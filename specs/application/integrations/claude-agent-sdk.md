# Claude Agent SDK Integration Specification

## Overview

Specification for integrating Claude Agent SDK (@anthropic-ai/claude-agent-sdk v0.2.9) into AgentPane. This document covers the `query()` function usage, tool definitions, event hooks for streaming, error recovery, and integration with AgentService.

---

## Package Information

| Package | Version | Purpose |
|---------|---------|---------|
| @anthropic-ai/claude-agent-sdk | 0.2.9 | Agentic AI execution with tool use |
| zod | 4.3.5 | Schema validation for tool inputs |

---

## Core Concepts

### query() Function

The SDK's primary entry point is the `query()` function - an async generator that yields messages as the agent executes.

```typescript
// lib/agents/core.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface AgentQueryOptions {
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  systemPrompt?: string;
  hooks?: AgentHooks;
}

export async function* executeAgentQuery(options: AgentQueryOptions) {
  for await (const message of query({
    prompt: options.prompt,
    options: {
      allowedTools: options.allowedTools,
      model: options.model,
      maxTurns: options.maxTurns,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      hooks: options.hooks,
    },
  })) {
    yield message;
  }
}
```

### Message Types

The query generator yields different message types:

```typescript
// lib/agents/types.ts
import { z } from 'zod';

export const agentMessageSchema = z.discriminatedUnion('type', [
  // Partial text being streamed
  z.object({
    type: z.literal('stream_event'),
    event: z.object({
      type: z.string(),
      delta: z.object({
        text: z.string().optional(),
      }).optional(),
    }),
  }),
  // Complete assistant response
  z.object({
    type: z.literal('assistant_message'),
    content: z.array(z.object({
      type: z.literal('text'),
      text: z.string(),
    })),
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
    content: z.array(z.object({
      type: z.enum(['text', 'image']),
      text: z.string().optional(),
    })),
  }),
  // Final result
  z.object({
    type: z.literal('result'),
    result: z.string(),
  }),
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;
```

---

## Tool Definitions

### tool() Function Signature

Define custom tools using the `tool()` function with Zod schemas:

```typescript
// lib/agents/tools/index.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Signature: tool(name, description, schema, handler)
export const readFileTool = tool(
  'read_file',
  'Read the contents of a file at the specified path',
  z.object({
    file_path: z.string().describe('Absolute path to the file to read'),
    encoding: z.enum(['utf-8', 'base64']).default('utf-8').describe('File encoding'),
  }),
  async (args) => {
    const content = await Bun.file(args.file_path).text();
    return {
      content: [{ type: 'text' as const, text: content }],
    };
  }
);
```

### Standard Tool Definitions

```typescript
// lib/agents/tools/file-tools.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Edit tool - replaces text in a file
export const editFileTool = tool(
  'edit_file',
  'Replace specific text in a file. The old_string must match exactly.',
  z.object({
    file_path: z.string().describe('Absolute path to the file'),
    old_string: z.string().describe('Text to find and replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().default(false).describe('Replace all occurrences'),
  }),
  async (args) => {
    const file = Bun.file(args.file_path);
    let content = await file.text();

    if (args.replace_all) {
      content = content.replaceAll(args.old_string, args.new_string);
    } else {
      content = content.replace(args.old_string, args.new_string);
    }

    await Bun.write(args.file_path, content);

    return {
      content: [{ type: 'text' as const, text: `Successfully edited ${args.file_path}` }],
    };
  }
);

// Write tool - creates or overwrites a file
export const writeFileTool = tool(
  'write_file',
  'Create or overwrite a file with the specified content',
  z.object({
    file_path: z.string().describe('Absolute path to the file'),
    content: z.string().describe('Content to write'),
  }),
  async (args) => {
    await Bun.write(args.file_path, args.content);
    return {
      content: [{ type: 'text' as const, text: `Successfully wrote ${args.file_path}` }],
    };
  }
);
```

### Bash Tool with Sandboxing

```typescript
// lib/agents/tools/bash-tool.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { $ } from 'bun';

// Dangerous commands that require explicit approval
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

export const bashTool = tool(
  'bash',
  'Execute a bash command in the agent worktree',
  z.object({
    command: z.string().describe('Bash command to execute'),
    cwd: z.string().optional().describe('Working directory for command'),
    timeout: z.number().default(120000).describe('Timeout in milliseconds'),
  }),
  async (args, context) => {
    // Check for dangerous commands
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(args.command)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Dangerous command blocked: ${args.command}. Requires explicit user approval.`,
          }],
          is_error: true,
        };
      }
    }

    try {
      const result = await $`${args.command}`.cwd(args.cwd ?? context.cwd).timeout(args.timeout);

      return {
        content: [{
          type: 'text' as const,
          text: result.stdout.toString() || '(no output)',
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        is_error: true,
      };
    }
  }
);
```

### Glob and Grep Tools

```typescript
// lib/agents/tools/search-tools.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Glob } from 'bun';

export const globTool = tool(
  'glob',
  'Find files matching a glob pattern',
  z.object({
    pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
    cwd: z.string().optional().describe('Directory to search from'),
    limit: z.number().default(100).describe('Maximum files to return'),
  }),
  async (args, context) => {
    const glob = new Glob(args.pattern);
    const files: string[] = [];

    for await (const file of glob.scan({ cwd: args.cwd ?? context.cwd })) {
      files.push(file);
      if (files.length >= args.limit) break;
    }

    return {
      content: [{
        type: 'text' as const,
        text: files.length > 0 ? files.join('\n') : '(no matches)',
      }],
    };
  }
);

export const grepTool = tool(
  'grep',
  'Search for text patterns in files',
  z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().describe('File or directory to search'),
    glob: z.string().optional().describe('File glob filter'),
    max_results: z.number().default(50).describe('Maximum results'),
  }),
  async (args, context) => {
    const { $ } = await import('bun');

    const cmd = args.glob
      ? `rg "${args.pattern}" --glob "${args.glob}" --max-count ${args.max_results} ${args.path}`
      : `rg "${args.pattern}" --max-count ${args.max_results} ${args.path}`;

    try {
      const result = await $`${cmd}`.cwd(context.cwd);
      return {
        content: [{
          type: 'text' as const,
          text: result.stdout.toString() || '(no matches)',
        }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: '(no matches)' }],
      };
    }
  }
);
```

---

## PreToolUse / PostToolUse Hooks

Hooks enable event publishing to Durable Sessions for real-time UI updates.

### Hook Registration Pattern

```typescript
// lib/agents/hooks.ts
import type { PreToolUseHook, PostToolUseHook } from '@anthropic-ai/claude-agent-sdk';
import { publishAgentStep } from '../streams/server';

export interface AgentHooks {
  PreToolUse: PreToolUseHook[];
  PostToolUse: PostToolUseHook[];
}

export function createAgentHooks(agentId: string, sessionId: string): AgentHooks {
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        // Publish tool start event to Durable Session
        publishAgentStep(agentId, {
          type: 'tool:start',
          sessionId,
          tool: input.tool_name,
          input: input.tool_input,
          timestamp: Date.now(),
        });

        // Return empty object to continue (no modifications)
        return {};
      }],
    }],

    PostToolUse: [{
      hooks: [async (input) => {
        // Publish tool completion event
        publishAgentStep(agentId, {
          type: 'tool:result',
          sessionId,
          tool: input.tool_name,
          input: input.tool_input,
          output: input.tool_response,
          duration: input.duration_ms,
          timestamp: Date.now(),
        });

        return {};
      }],
    }],
  };
}
```

### Tool Whitelist Enforcement Hook

```typescript
// lib/agents/hooks/tool-whitelist.ts
import type { PreToolUseHook } from '@anthropic-ai/claude-agent-sdk';
import { AgentErrors } from '../../errors/agent-errors';

export function createToolWhitelistHook(allowedTools: string[]): PreToolUseHook {
  return {
    hooks: [async (input) => {
      if (!allowedTools.includes(input.tool_name)) {
        // Block the tool call
        return {
          decision: 'block',
          message: `Tool "${input.tool_name}" is not allowed. Allowed tools: ${allowedTools.join(', ')}`,
        };
      }

      return {};
    }],
  };
}
```

### Audit Trail Hook

```typescript
// lib/agents/hooks/audit.ts
import type { PostToolUseHook } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../../db/client';
import { auditLogs } from '../../db/schema';

export function createAuditHook(
  agentId: string,
  agentRunId: string,
  taskId: string | null,
  projectId: string
): PostToolUseHook {
  let turnNumber = 0;

  return {
    hooks: [async (input) => {
      turnNumber++;

      await db.insert(auditLogs).values({
        agentId,
        agentRunId,
        taskId,
        projectId,
        tool: input.tool_name,
        status: input.tool_response.is_error ? 'error' : 'complete',
        input: input.tool_input as Record<string, unknown>,
        output: input.tool_response.content as Record<string, unknown>,
        error: input.tool_response.is_error
          ? (input.tool_response.content[0] as { text?: string })?.text
          : null,
        duration: input.duration_ms,
        turnNumber,
      });

      return {};
    }],
  };
}
```

---

## Stream Handling

### Real-time Token Streaming

```typescript
// lib/agents/stream-handler.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { publishAgentStep } from '../streams/server';

export async function runAgentWithStreaming(
  agentId: string,
  sessionId: string,
  prompt: string,
  options: {
    allowedTools: string[];
    maxTurns: number;
    model: string;
    cwd: string;
  }
) {
  const hooks = createAgentHooks(agentId, sessionId);
  let turn = 0;
  let accumulatedText = '';

  for await (const message of query({
    prompt,
    options: {
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      model: options.model,
      includePartialMessages: true,
      hooks,
    },
  })) {
    // Handle stream events for real-time token updates
    if (message.type === 'stream_event') {
      const delta = message.event?.delta?.text;
      if (delta) {
        accumulatedText += delta;
        publishAgentStep(agentId, {
          type: 'stream:token',
          sessionId,
          text: delta,
          accumulated: accumulatedText,
          timestamp: Date.now(),
        });
      }
    }

    // Handle complete assistant messages
    if (message.type === 'assistant_message') {
      turn++;
      accumulatedText = '';

      publishAgentStep(agentId, {
        type: 'agent:turn',
        sessionId,
        turn,
        content: message.content,
        timestamp: Date.now(),
      });
    }

    // Handle tool use
    if (message.type === 'tool_use') {
      publishAgentStep(agentId, {
        type: 'tool:invoke',
        sessionId,
        toolId: message.id,
        tool: message.name,
        input: message.input,
        timestamp: Date.now(),
      });
    }

    // Handle final result
    if (message.type === 'result') {
      publishAgentStep(agentId, {
        type: 'agent:complete',
        sessionId,
        result: message.result,
        turns: turn,
        timestamp: Date.now(),
      });

      return message.result;
    }
  }
}
```

---

## Error Recovery Patterns

### Retry with Exponential Backoff

```typescript
// lib/agents/recovery.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface RetryOptions {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
};

export async function queryWithRetry(
  queryOptions: Parameters<typeof query>[0],
  retryOptions: Partial<RetryOptions> = {}
) {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  let lastError: Error | null = null;
  let delay = opts.initialDelay;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const results: unknown[] = [];

      for await (const message of query(queryOptions)) {
        results.push(message);

        if ('result' in message) {
          return { ok: true as const, results, message };
        }
      }

      // Completed without explicit result
      return { ok: true as const, results, message: results[results.length - 1] };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        return { ok: false as const, error: lastError };
      }

      if (attempt < opts.maxRetries) {
        await sleep(delay);
        delay = Math.min(delay * opts.backoffFactor, opts.maxDelay);
      }
    }
  }

  return { ok: false as const, error: lastError! };
}

function isRetryableError(error: Error): boolean {
  const retryablePatterns = [
    /rate limit/i,
    /timeout/i,
    /connection reset/i,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /503/,
    /529/,
  ];

  return retryablePatterns.some(pattern => pattern.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Graceful Degradation

```typescript
// lib/agents/recovery/graceful.ts
import { AgentErrors } from '../../errors/agent-errors';

export interface AgentExecutionContext {
  agentId: string;
  taskId: string;
  maxTurns: number;
  currentTurn: number;
}

export function handleAgentError(
  error: Error,
  context: AgentExecutionContext
): { shouldRetry: boolean; action: 'retry' | 'pause' | 'fail'; message: string } {
  const errorMessage = error.message.toLowerCase();

  // Rate limit - pause and retry later
  if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
    return {
      shouldRetry: true,
      action: 'pause',
      message: 'Rate limited. Agent will resume after cooldown.',
    };
  }

  // Turn limit reached - expected completion
  if (context.currentTurn >= context.maxTurns) {
    return {
      shouldRetry: false,
      action: 'pause',
      message: `Turn limit reached (${context.maxTurns}). Task moved to waiting approval.`,
    };
  }

  // Context length exceeded - summarize and continue
  if (errorMessage.includes('context length') || errorMessage.includes('token limit')) {
    return {
      shouldRetry: true,
      action: 'retry',
      message: 'Context limit reached. Conversation will be summarized.',
    };
  }

  // Network errors - retry
  if (errorMessage.includes('network') || errorMessage.includes('connection')) {
    return {
      shouldRetry: true,
      action: 'retry',
      message: 'Network error. Retrying...',
    };
  }

  // Unknown error - fail
  return {
    shouldRetry: false,
    action: 'fail',
    message: `Agent execution failed: ${error.message}`,
  };
}
```

---

## Turn Limit Handling

```typescript
// lib/agents/turn-limiter.ts
import { publishAgentState } from '../streams/server';

export interface TurnLimiterOptions {
  maxTurns: number;
  warningThreshold: number; // Percentage (e.g., 0.8 for 80%)
  onWarning: (turn: number, maxTurns: number) => void;
  onLimitReached: (turn: number) => void;
}

export class TurnLimiter {
  private currentTurn = 0;

  constructor(
    private agentId: string,
    private options: TurnLimiterOptions
  ) {}

  incrementTurn(): { canContinue: boolean; warning: boolean } {
    this.currentTurn++;

    const warningTurn = Math.floor(this.options.maxTurns * this.options.warningThreshold);
    const isWarning = this.currentTurn === warningTurn;
    const isLimitReached = this.currentTurn >= this.options.maxTurns;

    if (isWarning) {
      this.options.onWarning(this.currentTurn, this.options.maxTurns);
    }

    if (isLimitReached) {
      this.options.onLimitReached(this.currentTurn);
    }

    return {
      canContinue: !isLimitReached,
      warning: isWarning,
    };
  }

  getCurrentTurn(): number {
    return this.currentTurn;
  }

  getRemainingTurns(): number {
    return this.options.maxTurns - this.currentTurn;
  }
}

// Factory function
export function createTurnLimiter(
  agentId: string,
  sessionId: string,
  maxTurns: number
): TurnLimiter {
  return new TurnLimiter(agentId, {
    maxTurns,
    warningThreshold: 0.8,
    onWarning: (turn, max) => {
      publishAgentState(agentId, {
        status: 'running',
        sessionId,
        turn,
        warning: `Approaching turn limit: ${turn}/${max}`,
      });
    },
    onLimitReached: (turn) => {
      publishAgentState(agentId, {
        status: 'paused',
        sessionId,
        turn,
        message: `Turn limit reached (${turn}). Awaiting approval.`,
      });
    },
  });
}
```

---

## AgentService Integration

### Complete AgentService Implementation

```typescript
// lib/services/agent-service.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../db/client';
import { agents, agentRuns, tasks } from '../db/schema';
import { publishAgentState, publishAgentStep } from '../streams/server';
import { createAgentHooks, createToolWhitelistHook, createAuditHook } from './hooks';
import { createTurnLimiter } from './turn-limiter';
import { queryWithRetry, handleAgentError } from './recovery';
import { ok, err, type Result } from '../utils/result';
import { AgentErrors, type AgentError } from '../errors/agent-errors';
import type { AgentConfig, AgentStatus } from '../db/schema';

export interface StartAgentInput {
  agentId: string;
  taskId: string;
  prompt: string;
  sessionId: string;
}

export interface AgentResult {
  runId: string;
  result: string;
  turns: number;
  status: AgentStatus;
}

export class AgentService {
  /**
   * Start an agent to work on a task
   */
  async startAgent(input: StartAgentInput): Promise<Result<AgentResult, AgentError>> {
    const { agentId, taskId, prompt, sessionId } = input;

    // Fetch agent configuration
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      with: { project: true },
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    if (agent.status === 'running') {
      return err(AgentErrors.ALREADY_RUNNING(agent.currentTaskId ?? undefined));
    }

    // Fetch task and worktree info
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { worktree: true },
    });

    if (!task || !task.worktree) {
      return err(AgentErrors.NO_AVAILABLE_TASK);
    }

    const config = agent.config as AgentConfig;
    const cwd = task.worktree.path;

    // Create agent run record
    const [run] = await db.insert(agentRuns).values({
      id: createId(),
      agentId,
      taskId,
      projectId: agent.projectId,
      sessionId,
      status: 'starting',
      prompt,
    }).returning();

    // Update agent status
    await db.update(agents)
      .set({
        status: 'running',
        currentTaskId: taskId,
        currentSessionId: sessionId,
        currentWorktreeId: task.worktreeId,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    // Publish state change
    publishAgentState(agentId, {
      status: 'running',
      sessionId,
      taskId,
    });

    try {
      // Create hooks
      const hooks = {
        ...createAgentHooks(agentId, sessionId),
        PreToolUse: [
          createToolWhitelistHook(config.allowedTools),
          ...createAgentHooks(agentId, sessionId).PreToolUse,
        ],
        PostToolUse: [
          createAuditHook(agentId, run.id, taskId, agent.projectId),
          ...createAgentHooks(agentId, sessionId).PostToolUse,
        ],
      };

      // Create turn limiter
      const turnLimiter = createTurnLimiter(agentId, sessionId, config.maxTurns);

      // Update run status to running
      await db.update(agentRuns)
        .set({ status: 'running' })
        .where(eq(agentRuns.id, run.id));

      // Execute agent with retry support
      const queryResult = await queryWithRetry({
        prompt,
        options: {
          allowedTools: config.allowedTools,
          model: config.model,
          maxTurns: config.maxTurns,
          includePartialMessages: true,
          hooks,
          cwd,
        },
      });

      if (!queryResult.ok) {
        const recovery = handleAgentError(queryResult.error, {
          agentId,
          taskId,
          maxTurns: config.maxTurns,
          currentTurn: turnLimiter.getCurrentTurn(),
        });

        if (recovery.action === 'fail') {
          await this.handleAgentFailure(agentId, run.id, queryResult.error);
          return err(AgentErrors.EXECUTION_ERROR(queryResult.error.message));
        }

        if (recovery.action === 'pause') {
          await this.handleAgentPause(agentId, run.id, recovery.message);
          return ok({
            runId: run.id,
            result: recovery.message,
            turns: turnLimiter.getCurrentTurn(),
            status: 'paused',
          });
        }
      }

      // Success - update records
      const finalTurns = turnLimiter.getCurrentTurn();
      const result = queryResult.message && 'result' in queryResult.message
        ? queryResult.message.result
        : 'Task completed';

      await db.update(agentRuns)
        .set({
          status: 'completed',
          result,
          turnCount: finalTurns,
          completedAt: new Date(),
          duration: Date.now() - run.startedAt.getTime(),
        })
        .where(eq(agentRuns.id, run.id));

      await db.update(agents)
        .set({
          status: 'idle',
          currentTaskId: null,
          currentSessionId: null,
          currentWorktreeId: null,
          completedTasks: agent.completedTasks + 1,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));

      // Move task to waiting approval
      await db.update(tasks)
        .set({
          column: 'waiting_approval',
          turnCount: finalTurns,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      publishAgentState(agentId, {
        status: 'completed',
        sessionId,
        taskId,
        result,
        turns: finalTurns,
      });

      return ok({
        runId: run.id,
        result,
        turns: finalTurns,
        status: 'completed',
      });
    } catch (error) {
      await this.handleAgentFailure(
        agentId,
        run.id,
        error instanceof Error ? error : new Error(String(error))
      );

      return err(AgentErrors.EXECUTION_ERROR(
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  /**
   * Stop a running agent
   */
  async stopAgent(agentId: string): Promise<Result<void, AgentError>> {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    if (agent.status !== 'running') {
      return err(AgentErrors.NOT_RUNNING);
    }

    await db.update(agents)
      .set({
        status: 'paused',
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    publishAgentState(agentId, {
      status: 'paused',
      sessionId: agent.currentSessionId ?? undefined,
      message: 'Agent stopped by user',
    });

    return ok(undefined);
  }

  /**
   * Resume a paused agent
   */
  async resumeAgent(
    agentId: string,
    feedback?: string
  ): Promise<Result<AgentResult, AgentError>> {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    if (agent.status !== 'paused') {
      return err(AgentErrors.NOT_RUNNING);
    }

    if (!agent.currentTaskId || !agent.currentSessionId) {
      return err(AgentErrors.NO_AVAILABLE_TASK);
    }

    const prompt = feedback
      ? `Continue with the following feedback: ${feedback}`
      : 'Continue with the task';

    return this.startAgent({
      agentId,
      taskId: agent.currentTaskId,
      prompt,
      sessionId: agent.currentSessionId,
    });
  }

  private async handleAgentFailure(
    agentId: string,
    runId: string,
    error: Error
  ): Promise<void> {
    await db.update(agentRuns)
      .set({
        status: 'error',
        error: error.message,
        errorType: error.name,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    await db.update(agents)
      .set({
        status: 'error',
        lastError: error.message,
        lastErrorAt: new Date(),
        failedTasks: (agent?.failedTasks ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    publishAgentState(agentId, {
      status: 'error',
      error: error.message,
    });
  }

  private async handleAgentPause(
    agentId: string,
    runId: string,
    message: string
  ): Promise<void> {
    await db.update(agentRuns)
      .set({
        status: 'paused',
        result: message,
      })
      .where(eq(agentRuns.id, runId));

    await db.update(agents)
      .set({
        status: 'paused',
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    publishAgentState(agentId, {
      status: 'paused',
      message,
    });
  }
}

// Export singleton
export const agentService = new AgentService();
```

---

## Configuration Types

```typescript
// lib/agents/config.ts
import { z } from 'zod';

export const agentConfigSchema = z.object({
  allowedTools: z.array(z.string()).default([
    'Read',
    'Edit',
    'Write',
    'Bash',
    'Glob',
    'Grep',
  ]),
  maxTurns: z.number().min(1).max(100).default(50),
  model: z.string().default('claude-sonnet-4-6'),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  retryOptions: z.object({
    maxRetries: z.number().default(3),
    initialDelay: z.number().default(1000),
    maxDelay: z.number().default(30000),
    backoffFactor: z.number().default(2),
  }).optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Default tool whitelist
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
];

// Model options
export const SUPPORTED_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-20250514',
  'claude-haiku-4-20250514',
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Durable Sessions](./durable-sessions.md) | Receives agent events via publish functions |
| [Database Schema](../database/schema.md) | Agent, AgentRun, AuditLog tables |
| [Error Catalog](../errors/error-catalog.md) | AgentError types |
| [User Stories](../user-stories.md) | Real-time visibility, sandboxing requirements |
| [Wireframes](../wireframes/) | Stream view, tool output display |
