export type SdkStreamEvent = Record<string, unknown>;

export class SdkStreamBuilder {
  private readonly events: SdkStreamEvent[] = [];

  systemInit(sessionId = 'sdk-session-123'): this {
    this.events.push({ type: 'system', subtype: 'init', session_id: sessionId });
    return this;
  }

  messageStart(): this {
    this.events.push({ type: 'stream_event', event: { type: 'message_start' } });
    return this;
  }

  textDelta(text: string): this {
    this.events.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    return this;
  }

  toolUse(toolName: string, id = `tool-${this.events.length + 1}`): this {
    this.events.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id, name: toolName, input: {} },
      },
    });
    return this;
  }

  toolResult(toolUseId: string, content: string, isError = false): this {
    this.events.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
      },
    });
    return this;
  }

  exitPlanMode(plan = 'Implementation plan here', id = 'tool-exit-plan'): this {
    this.events.push({
      type: 'tool_use_summary',
      tool_name: 'ExitPlanMode',
      tool_use_id: id,
      is_error: false,
      summary: plan,
      preceding_tool_use_ids: [],
    });
    return this;
  }

  assistantText(text: string): this {
    this.events.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    return this;
  }

  resultSuccess(result = 'Task completed successfully', turnCount = 1): this {
    this.events.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result,
      turn_count: turnCount,
    });
    return this;
  }

  resultError(error = 'SDK error', turnCount = 1): this {
    this.events.push({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error,
      turn_count: turnCount,
    });
    return this;
  }

  resultTurnLimit(turnCount = 50): this {
    this.events.push({
      type: 'result',
      subtype: 'turn_limit',
      is_error: false,
      turn_count: turnCount,
    });
    return this;
  }

  build(): AsyncIterable<SdkStreamEvent> {
    const events = [...this.events];
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }

  toArray(): SdkStreamEvent[] {
    return [...this.events];
  }
}

export function sdkStream(): SdkStreamBuilder {
  return new SdkStreamBuilder();
}
