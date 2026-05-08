import { Readable } from 'node:stream';

type AgentRunnerEvent = {
  type: string;
  timestamp: number;
  taskId: string;
  sessionId: string;
  codespaceId?: string;
  data?: Record<string, unknown>;
};

export class AgentRunnerStreamBuilder {
  private readonly events: AgentRunnerEvent[] = [];

  constructor(
    private readonly taskId: string,
    private readonly sessionId: string,
    private readonly codespaceId?: string
  ) {}

  planReady(plan: string, sdkSessionId = 'sdk-session-123', turnCount = 1): this {
    return this.push('agent:plan_ready', { plan, sdkSessionId, turnCount });
  }

  toolStart(toolName: string, toolUseId = `tool-${this.events.length + 1}`): this {
    return this.push('agent:tool:start', { toolName, toolUseId });
  }

  toolResult(toolUseId: string, output: string, isError = false): this {
    return this.push('agent:tool:result', { toolUseId, output, isError });
  }

  chunk(text: string): this {
    return this.push('agent:chunk', { text });
  }

  complete(status: 'completed' | 'turn_limit' = 'completed', turnCount = 1): this {
    return this.push('agent:complete', { status, turnCount });
  }

  error(error: string, turnCount = 1): this {
    return this.push('agent:error', { error, turnCount });
  }

  message(role: string, content: string): this {
    return this.push('agent:message', { role, content });
  }

  push(type: string, data: Record<string, unknown> = {}): this {
    this.events.push({
      type,
      timestamp: Date.now(),
      taskId: this.taskId,
      sessionId: this.sessionId,
      codespaceId: this.codespaceId,
      data,
    });
    return this;
  }

  buildLines(): string[] {
    return this.events.map((event) => JSON.stringify(event));
  }

  build(): Readable {
    const body = `${this.buildLines().join('\n')}\n`;
    return Readable.from([body]);
  }
}

export function agentRunnerStream(
  taskId: string,
  sessionId: string,
  codespaceId?: string
): AgentRunnerStreamBuilder {
  return new AgentRunnerStreamBuilder(taskId, sessionId, codespaceId);
}

export function agentRunnerLinesToStream(lines: readonly string[]): Readable {
  return Readable.from([`${lines.join('\n')}\n`]);
}
