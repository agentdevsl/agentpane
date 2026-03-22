/**
 * Mock builders for container bridge and agent runner event testing.
 *
 * These utilities create JSON event lines that simulate the agent-runner's stdout output.
 * Each builder creates a properly formatted JSON string ready to be parsed by the container bridge.
 */
import { Readable } from 'node:stream';
import type {
  ContainerAgentEvent,
  ContainerAgentEventType,
} from '../../src/lib/agents/container-bridge.js';

/**
 * Creates a base agent event with common fields.
 */
function createBaseEvent(
  type: ContainerAgentEventType,
  taskId: string,
  sessionId: string,
  data: Record<string, unknown> = {}
): string {
  const event: ContainerAgentEvent = {
    type,
    timestamp: Date.now(),
    taskId,
    sessionId,
    data,
  };
  return JSON.stringify(event);
}

/**
 * Creates an agent:started event.
 * Emitted when the agent begins execution.
 */
export function createAgentStartedEvent(
  taskId: string,
  sessionId: string,
  data?: {
    model?: string;
    maxTurns?: number;
    [key: string]: unknown;
  }
): string {
  const defaultData = {
    model: 'claude-sonnet-4-6',
    maxTurns: 50,
    ...data,
  };
  return createBaseEvent('agent:started', taskId, sessionId, defaultData);
}

/**
 * Creates an agent:token event for streaming tokens.
 * Emitted as the agent generates text output.
 */
export function createAgentTokenEvent(taskId: string, sessionId: string, delta: string): string {
  const data: Record<string, unknown> = { delta };
  return createBaseEvent('agent:token', taskId, sessionId, data);
}

/**
 * Creates an agent:turn event for turn completion.
 * Emitted when the agent completes a turn.
 */
export function createAgentTurnEvent(
  taskId: string,
  sessionId: string,
  turn: number,
  maxTurns?: number
): string {
  const data: Record<string, unknown> = { turn };
  if (maxTurns !== undefined) {
    data.maxTurns = maxTurns;
  }
  return createBaseEvent('agent:turn', taskId, sessionId, data);
}

/**
 * Creates an agent:tool:start event.
 * Emitted when a tool invocation begins.
 */
export function createAgentToolStartEvent(
  taskId: string,
  sessionId: string,
  toolName: string,
  toolId?: string,
  input?: Record<string, unknown>
): string {
  const data: Record<string, unknown> = { toolName };
  if (toolId !== undefined) {
    data.toolId = toolId;
  }
  if (input !== undefined) {
    data.input = input;
  }
  return createBaseEvent('agent:tool:start', taskId, sessionId, data);
}

/**
 * Creates an agent:tool:result event.
 * Emitted when a tool invocation completes.
 */
export function createAgentToolResultEvent(
  taskId: string,
  sessionId: string,
  toolName: string,
  toolId?: string,
  result?: string | Record<string, unknown>,
  isError?: boolean
): string {
  const data: Record<string, unknown> = { toolName };
  if (toolId !== undefined) {
    data.toolId = toolId;
  }
  if (result !== undefined) {
    data.result = result;
  }
  if (isError !== undefined) {
    data.isError = isError;
  }
  return createBaseEvent('agent:tool:result', taskId, sessionId, data);
}

/**
 * Creates an agent:complete event.
 * Emitted when the agent completes successfully or reaches turn limit.
 */
export function createAgentCompleteEvent(
  taskId: string,
  sessionId: string,
  status?: 'completed' | 'turn_limit' | 'cancelled',
  turnCount?: number,
  result?: string
): string {
  const data: Record<string, unknown> = {
    status: status ?? 'completed',
    turnCount: turnCount ?? 1,
  };
  if (result !== undefined) {
    data.result = result;
  }
  return createBaseEvent('agent:complete', taskId, sessionId, data);
}

/**
 * Creates an agent:error event.
 * Emitted when the agent encounters an error.
 */
export function createAgentErrorEvent(
  taskId: string,
  sessionId: string,
  error: string,
  code?: string,
  turnCount?: number
): string {
  const data: Record<string, unknown> = {
    error,
    turnCount: turnCount ?? 0,
  };
  if (code !== undefined) {
    data.code = code;
  }
  return createBaseEvent('agent:error', taskId, sessionId, data);
}

/**
 * Creates an agent:plan_ready event.
 * Emitted when the agent completes planning phase and is ready for approval.
 */
export function createAgentPlanReadyEvent(
  taskId: string,
  sessionId: string,
  plan: string,
  sdkSessionId?: string,
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>
): string {
  const data: Record<string, unknown> = {
    plan,
    turnCount: 1,
    sdkSessionId: sdkSessionId ?? `sdk-session-${Date.now()}`,
  };
  if (allowedPrompts !== undefined) {
    data.allowedPrompts = allowedPrompts;
  }
  return createBaseEvent('agent:plan_ready', taskId, sessionId, data);
}

/**
 * Creates an agent:file_changed event.
 * Emitted when the agent modifies a file.
 */
export function createAgentFileChangedEvent(
  taskId: string,
  sessionId: string,
  path: string,
  action: 'created' | 'modified' | 'deleted',
  toolName?: string,
  additions?: number,
  deletions?: number
): string {
  const data: Record<string, unknown> = {
    path,
    action,
  };
  if (toolName !== undefined) {
    data.toolName = toolName;
  }
  if (additions !== undefined) {
    data.additions = additions;
  }
  if (deletions !== undefined) {
    data.deletions = deletions;
  }
  return createBaseEvent('agent:file_changed', taskId, sessionId, data);
}

/**
 * Creates a mock event stream from an array of event JSON strings.
 * Returns a readable stream that emits the events as newline-delimited JSON.
 *
 * @param events - Array of event JSON strings (from the builder functions above)
 * @returns Readable stream emitting JSON lines
 */
export function createMockEventStream(events: string[]): Readable {
  const lines = events.map((event) => `${event}\n`);
  const stream = Readable.from(lines);
  return stream;
}

/**
 * Creates a full agent session simulation with realistic event sequence.
 * Useful for integration test scenarios.
 *
 * @param taskId - Task ID for the session
 * @param sessionId - Session ID for the session
 * @returns Array of event JSON strings representing a complete agent run
 */
export function createFullAgentSession(taskId: string, sessionId: string): string[] {
  const events: string[] = [];

  // 1. Agent started
  events.push(createAgentStartedEvent(taskId, sessionId));

  // 2. Turn 1: Read files
  events.push(createAgentTurnEvent(taskId, sessionId, 1, 50));
  events.push(
    createAgentToolStartEvent(taskId, sessionId, 'Read', 'tool-1', {
      file_path: '/workspace/src/index.ts',
    })
  );
  events.push(
    createAgentToolResultEvent(
      taskId,
      sessionId,
      'Read',
      'tool-1',
      'export function main() {\n  console.log("Hello, world!");\n}'
    )
  );
  events.push(createAgentTokenEvent(taskId, sessionId, 'I can see the main function. '));
  events.push(
    createAgentTokenEvent(
      taskId,
      sessionId,
      'Let me update it.\n',
      'I can see the main function. Let me update it.\n'
    )
  );

  // 3. Turn 2: Edit file
  events.push(createAgentTurnEvent(taskId, sessionId, 2, 50));
  events.push(
    createAgentToolStartEvent(taskId, sessionId, 'Edit', 'tool-2', {
      file_path: '/workspace/src/index.ts',
      old_string: 'console.log("Hello, world!");',
      new_string: 'console.log("Hello from AgentPane!");',
    })
  );
  events.push(
    createAgentToolResultEvent(taskId, sessionId, 'Edit', 'tool-2', 'File edited successfully')
  );
  events.push(
    createAgentFileChangedEvent(
      taskId,
      sessionId,
      '/workspace/src/index.ts',
      'modified',
      'Edit',
      1,
      1
    )
  );
  events.push(createAgentTokenEvent(taskId, sessionId, 'Updated the greeting message.'));

  // 4. Turn 3: Run tests
  events.push(createAgentTurnEvent(taskId, sessionId, 3, 50));
  events.push(
    createAgentToolStartEvent(taskId, sessionId, 'Bash', 'tool-3', {
      command: 'npm test',
      description: 'Run test suite',
    })
  );
  events.push(
    createAgentToolResultEvent(taskId, sessionId, 'Bash', 'tool-3', 'All tests passed (3/3)')
  );
  events.push(createAgentTokenEvent(taskId, sessionId, 'All tests are passing. Task complete!'));

  // 5. Additional file changes
  events.push(
    createAgentFileChangedEvent(taskId, sessionId, '/workspace/README.md', 'modified', 'Edit', 5, 2)
  );

  // 6. Agent complete
  events.push(
    createAgentCompleteEvent(
      taskId,
      sessionId,
      'completed',
      3,
      'Successfully updated greeting message'
    )
  );

  return events;
}

/**
 * Creates an agent session that ends in error.
 * Useful for testing error handling.
 */
export function createErrorAgentSession(taskId: string, sessionId: string): string[] {
  const events: string[] = [];

  events.push(createAgentStartedEvent(taskId, sessionId));
  events.push(createAgentTurnEvent(taskId, sessionId, 1, 50));
  events.push(
    createAgentToolStartEvent(taskId, sessionId, 'Bash', 'tool-1', {
      command: 'npm install nonexistent-package',
    })
  );
  events.push(
    createAgentToolResultEvent(
      taskId,
      sessionId,
      'Bash',
      'tool-1',
      'Error: Package not found',
      true
    )
  );
  events.push(
    createAgentErrorEvent(taskId, sessionId, 'Failed to install dependencies', 'INSTALL_ERROR', 1)
  );

  return events;
}

/**
 * Creates an agent session that reaches turn limit.
 * Useful for testing turn limit handling.
 */
export function createTurnLimitAgentSession(
  taskId: string,
  sessionId: string,
  maxTurns = 3
): string[] {
  const events: string[] = [];

  events.push(createAgentStartedEvent(taskId, sessionId, { maxTurns }));

  for (let turn = 1; turn <= maxTurns; turn++) {
    events.push(createAgentTurnEvent(taskId, sessionId, turn, maxTurns));
    events.push(createAgentTokenEvent(taskId, sessionId, `Working on turn ${turn}...`));
  }

  events.push(createAgentCompleteEvent(taskId, sessionId, 'turn_limit', maxTurns));

  return events;
}

/**
 * Creates an agent session in planning mode.
 * Useful for testing plan approval flow.
 */
export function createPlanningAgentSession(taskId: string, sessionId: string): string[] {
  const events: string[] = [];

  events.push(createAgentStartedEvent(taskId, sessionId, { maxTurns: 10 }));
  events.push(createAgentTurnEvent(taskId, sessionId, 1, 10));

  events.push(
    createAgentToolStartEvent(taskId, sessionId, 'Read', 'tool-1', {
      file_path: '/workspace/src/index.ts',
    })
  );
  events.push(
    createAgentToolResultEvent(
      taskId,
      sessionId,
      'Read',
      'tool-1',
      'export function main() { /* ... */ }'
    )
  );

  events.push(createAgentTokenEvent(taskId, sessionId, 'Analyzing codebase... '));
  events.push(createAgentTokenEvent(taskId, sessionId, 'Creating implementation plan.\n'));

  const plan = `## Implementation Plan

1. Update main function to use new greeting
2. Add unit tests for greeting function
3. Update documentation

This will take approximately 3 turns.`;

  events.push(
    createAgentPlanReadyEvent(taskId, sessionId, plan, `sdk-session-${Date.now()}`, [
      { tool: 'Bash', prompt: 'npm test' },
      { tool: 'Bash', prompt: 'npm run build' },
    ])
  );

  return events;
}
