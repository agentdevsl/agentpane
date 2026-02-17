import { describe, expect, it } from 'vitest';
import { parseJsonlFile } from '../parser.js';
import { SessionStore } from '../session-store.js';

// ── Helpers ──

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'uuid-1',
    timestamp: '2025-01-15T12:00:00.000Z',
    sessionId: 'sess-1',
    cwd: '/home/user/my-project',
    parentUuid: null,
    ...overrides,
  };
}

function toJsonl(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

function parseEvents(
  lines: string,
  filePath = '/home/user/.claude/projects/abc123/sess-1.jsonl'
): SessionStore {
  const store = new SessionStore();
  parseJsonlFile(filePath, lines, 0, store);
  return store;
}

// ── Tests ──

describe('parseJsonlFile', () => {
  // ── Basic User Message ──

  describe('user messages', () => {
    it('creates a session with status "working" from a user message', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Fix the login bug' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');

      expect(session).toBeDefined();
      expect(session!.status).toBe('working');
      expect(session!.sessionId).toBe('sess-1');
      expect(session!.cwd).toBe('/home/user/my-project');
      expect(session!.projectName).toBe('my-project');
    });

    it('sets goal from first user text message', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Implement the search feature' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.goal).toBe('Implement the search feature');
    });

    it('truncates goal to 200 characters', () => {
      const longMessage = 'A'.repeat(300);
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: longMessage },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.goal).toHaveLength(200);
    });

    it('does not overwrite goal on subsequent user messages', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'First message' },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-2',
          message: { role: 'user', content: 'Second message' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.goal).toBe('First message');
    });

    it('clears pendingToolUse and sets status to working on tool_result', () => {
      const content = toJsonl(
        // First: assistant sends tool_use
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
          },
        }),
        // Then: user sends tool_result
        makeEvent({
          type: 'user',
          uuid: 'uuid-2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.pendingToolUse).toBeUndefined();
      expect(session!.status).toBe('working');
    });
  });

  // ── Assistant Messages ──

  describe('assistant messages', () => {
    it('updates recentOutput from text content', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I will fix the bug now.' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentOutput).toBe('I will fix the bug now.');
      expect(session!.status).toBe('working');
    });

    it('updates recentOutput from string content', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Simple text response',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentOutput).toBe('Simple text response');
    });

    it('truncates recentOutput to 500 characters', () => {
      const longText = 'B'.repeat(600);
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: longText }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentOutput).toHaveLength(500);
    });

    it('sets status to waiting_for_approval on tool_use', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.status).toBe('waiting_for_approval');
      expect(session!.pendingToolUse).toEqual({ toolName: 'Bash', toolId: 'tool-1' });
    });

    it('increments turnCount and sets status to waiting_for_input on stop_reason', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Done!',
            stop_reason: 'end_turn',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.turnCount).toBe(1);
      expect(session!.status).toBe('waiting_for_input');
    });

    it('handles stop_reason null (does not increment turnCount)', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Partial response',
            stop_reason: null,
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.turnCount).toBe(0);
      expect(session!.status).toBe('working');
    });

    it('uses last text block for recentOutput when multiple text blocks exist', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First paragraph' },
              { type: 'text', text: 'Second paragraph' },
            ],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentOutput).toBe('Second paragraph');
    });
  });

  // ── Summary Event ──

  describe('summary event', () => {
    it('sets status to idle', () => {
      const content = toJsonl(
        makeEvent({
          type: 'summary',
          summary: 'Session completed successfully.',
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.status).toBe('idle');
    });
  });

  // ── Token Accumulation ──

  describe('token accumulation', () => {
    it('sums token usage across multiple assistant messages', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'First',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
            },
          },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          message: {
            role: 'assistant',
            content: 'Second',
            usage: {
              input_tokens: 200,
              output_tokens: 80,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 30,
            },
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.tokenUsage).toEqual({
        inputTokens: 300,
        outputTokens: 130,
        cacheCreationTokens: 15,
        cacheReadTokens: 50,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
      });
    });

    it('handles missing usage field gracefully', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'No usage info',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
      });
    });
  });

  // ── Model Extraction ──

  describe('model extraction', () => {
    it('captures model from assistant message', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: 'Hello!',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.model).toBe('claude-sonnet-4-20250514');
    });
  });

  // ── Git Branch ──

  describe('git branch', () => {
    it('captures gitBranch from events', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          gitBranch: 'feature/awesome',
          message: { role: 'user', content: 'test' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.gitBranch).toBe('feature/awesome');
    });

    it('updates gitBranch from later events', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          gitBranch: 'main',
          message: { role: 'user', content: 'test' },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          gitBranch: 'feature/new',
          message: { role: 'assistant', content: 'Switched branch' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.gitBranch).toBe('feature/new');
    });
  });

  // ── Error Handling ──

  describe('error handling', () => {
    it('skips malformed non-last lines and continues parsing', () => {
      const content =
        'not valid json\n' +
        toJsonl(
          makeEvent({
            type: 'user',
            message: { role: 'user', content: 'valid event' },
          })
        );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      // Malformed non-last lines are skipped; valid lines after them are processed
      expect(session).toBeDefined();
      expect(session!.messageCount).toBe(1);
    });

    it('skips empty lines', () => {
      const content =
        '\n\n' +
        toJsonl(
          makeEvent({
            type: 'user',
            message: { role: 'user', content: 'after empty lines' },
          })
        ) +
        '\n\n';

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session).toBeDefined();
    });

    it('skips events without sessionId', () => {
      const content = toJsonl(
        { type: 'user', uuid: 'u1', timestamp: '2025-01-01T00:00:00Z' } // no sessionId
      );

      const store = parseEvents(content);
      expect(store.getSessionCount()).toBe(0);
    });

    it('skips events without type', () => {
      const content = toJsonl(
        { sessionId: 'sess-1', uuid: 'u1', timestamp: '2025-01-01T00:00:00Z' } // no type
      );

      const store = parseEvents(content);
      expect(store.getSessionCount()).toBe(0);
    });
  });

  // ── Subagent Detection ──

  describe('subagent detection', () => {
    it('sets isSubagent=true for files in /subagents/ path', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'subagent task' },
        })
      );

      const store = new SessionStore();
      parseJsonlFile(
        '/home/user/.claude/sessions/parent-sess/subagents/child-sess.jsonl',
        content,
        0,
        store
      );

      const session = store.getSession('sess-1');
      expect(session!.isSubagent).toBe(true);
      expect(session!.parentSessionId).toBe('parent-sess');
    });

    it('sets isSubagent=true when event has agentId', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'agent-123',
          message: { role: 'user', content: 'agent task' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.isSubagent).toBe(true);
    });

    it('sets isSubagent=false for normal session paths', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'normal task' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.isSubagent).toBe(false);
    });
  });

  // ── Project Extraction ──

  describe('project extraction', () => {
    it('extracts projectHash from file path', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'test' },
        })
      );

      const store = new SessionStore();
      parseJsonlFile('/home/user/.claude/projects/my-project-hash/sess-1.jsonl', content, 0, store);

      const session = store.getSession('sess-1');
      expect(session!.projectHash).toBe('my-project-hash');
    });

    it('extracts projectName from cwd', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          cwd: '/home/user/workspace/my-app',
          message: { role: 'user', content: 'test' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.projectName).toBe('my-app');
    });
  });

  // ── Message Counting ──

  describe('message counting', () => {
    it('counts both user and assistant messages', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          message: { role: 'assistant', content: 'Hi there!' },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-3',
          message: { role: 'user', content: 'Thanks' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.messageCount).toBe(3);
    });
  });

  // ── Partial Line Handling ──

  describe('partial line handling', () => {
    it('returns correct byte count excluding incomplete trailing line', () => {
      const validLine = JSON.stringify(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'hello' },
        })
      );
      const incompleteLine = '{"type":"user","uuid":"u2","sessionId":"sess-1"';
      const content = `${validLine}\n${incompleteLine}`;

      const store = new SessionStore();
      const bytesConsumed = parseJsonlFile('/test/path/sess-1.jsonl', content, 0, store);

      // Should only consume the valid line + newline, not the incomplete trailing line
      expect(bytesConsumed).toBe(Buffer.byteLength(`${validLine}\n`, 'utf-8'));
      expect(store.getSession('sess-1')).toBeDefined();
    });

    it('returns 0 bytes consumed when first line is invalid', () => {
      const content = '{"incomplete json';

      const store = new SessionStore();
      const bytesConsumed = parseJsonlFile('/test/path/sess-1.jsonl', content, 0, store);

      expect(bytesConsumed).toBe(0);
    });

    it('consumes empty lines correctly', () => {
      const validLine = JSON.stringify(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'test' },
        })
      );
      const content = `\n\n${validLine}\n`;

      const store = new SessionStore();
      const bytesConsumed = parseJsonlFile('/test/path/sess-1.jsonl', content, 0, store);

      expect(bytesConsumed).toBe(Buffer.byteLength(content, 'utf-8'));
    });
  });

  // ── Status Precedence ──

  describe('status precedence', () => {
    it('gives waiting_for_approval when message has both text and tool_use', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me run this command' },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
            ],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session).toBeDefined();
      expect(session!.status).toBe('waiting_for_approval');
      expect(session!.pendingToolUse).toEqual({ toolName: 'Bash', toolId: 'tool-1' });
    });

    it('does not override waiting_for_approval with stop_reason', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running command' },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
            ],
            stop_reason: 'end_turn',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.status).toBe('waiting_for_approval');
    });
  });

  // ── Timestamp Updates ──

  describe('timestamps', () => {
    it('updates lastActivityAt from event timestamps', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          timestamp: '2025-01-15T12:00:00.000Z',
          message: { role: 'user', content: 'First' },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          timestamp: '2025-01-15T12:05:00.000Z',
          message: { role: 'assistant', content: 'Later' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.lastActivityAt).toBe(Date.parse('2025-01-15T12:05:00.000Z'));
    });
  });

  // ── Thinking Blocks ──

  describe('thinking blocks', () => {
    it('does not treat thinking blocks as text output', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me analyze this...', signature: 'sig_abc' },
              { type: 'text', text: 'Here is my response.' },
            ],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentOutput).toBe('Here is my response.');
      expect(session!.status).toBe('working');
    });

    it('handles message with only thinking block (no text)', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Deep thought...', signature: 'sig_xyz' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      // No text block means no recentOutput update and no status change from content
      expect(session!.recentOutput).toBeUndefined();
    });

    it('does not affect status when mixed with tool_use', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Planning...', signature: 'sig_123' },
              { type: 'tool_use', id: 'tool-1', name: 'Read' },
            ],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.status).toBe('waiting_for_approval');
      expect(session!.pendingToolUse).toEqual({ toolName: 'Read', toolId: 'tool-1' });
    });
  });

  // ── Progress Events ──

  describe('progress events', () => {
    it('does not affect session state', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Do something' },
        }),
        makeEvent({
          type: 'progress',
          uuid: 'uuid-2',
          progressData: {
            type: 'hook_progress',
            hookEvent: 'PreToolUse',
            hookName: 'lint-check',
            command: 'npm run lint',
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session).toBeDefined();
      expect(session!.messageCount).toBe(1); // Only user message counted
      expect(session!.status).toBe('working');
    });

    it('creates session from progress event if first event', () => {
      const content = toJsonl(
        makeEvent({
          type: 'progress',
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session).toBeDefined();
      expect(session!.messageCount).toBe(0);
    });
  });

  // ── File History Snapshot Events ──

  describe('file-history-snapshot events', () => {
    it('does not affect session state', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Edit file' },
        }),
        makeEvent({
          type: 'file-history-snapshot',
          uuid: 'uuid-2',
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session).toBeDefined();
      expect(session!.messageCount).toBe(1);
    });
  });

  // ── Extended Token Usage ──

  describe('extended token usage (ephemeral cache)', () => {
    it('accumulates ephemeral cache tokens from cache_creation', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'First',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation: {
                ephemeral_5m_input_tokens: 30,
                ephemeral_1h_input_tokens: 15,
              },
            },
          },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          message: {
            role: 'assistant',
            content: 'Second',
            usage: {
              input_tokens: 200,
              output_tokens: 80,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 30,
              cache_creation: {
                ephemeral_5m_input_tokens: 20,
                ephemeral_1h_input_tokens: 10,
              },
            },
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.tokenUsage).toEqual({
        inputTokens: 300,
        outputTokens: 130,
        cacheCreationTokens: 15,
        cacheReadTokens: 50,
        ephemeral5mTokens: 50,
        ephemeral1hTokens: 25,
      });
    });

    it('handles usage without cache_creation sub-object', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'No ephemeral',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
            },
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.tokenUsage.ephemeral5mTokens).toBe(0);
      expect(session!.tokenUsage.ephemeral1hTokens).toBe(0);
    });

    it('mixes events with and without cache_creation', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'With ephemeral',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: {
                ephemeral_5m_input_tokens: 40,
                ephemeral_1h_input_tokens: 0,
              },
            },
          },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          message: {
            role: 'assistant',
            content: 'Without ephemeral',
            usage: {
              input_tokens: 200,
              output_tokens: 80,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 30,
            },
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.tokenUsage.ephemeral5mTokens).toBe(40);
      expect(session!.tokenUsage.ephemeral1hTokens).toBe(0);
    });
  });

  // ── Queue Operation Events ──

  describe('queue-operation events', () => {
    it('parses enqueue operation with content', () => {
      const content = toJsonl(
        makeEvent({
          type: 'queue-operation',
          operation: 'enqueue',
          message: { role: 'user', content: 'Run tests for the auth module' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.queueOperations).toHaveLength(1);
      expect(session!.queueOperations![0]!.operation).toBe('enqueue');
      expect(session!.queueOperations![0]!.content).toBe('Run tests for the auth module');
    });

    it('parses remove operation', () => {
      const content = toJsonl(
        makeEvent({
          type: 'queue-operation',
          operation: 'remove',
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.queueOperations).toHaveLength(1);
      expect(session!.queueOperations![0]!.operation).toBe('remove');
      expect(session!.queueOperations![0]!.content).toBeUndefined();
    });

    it('caps ring buffer at 20 operations', () => {
      const events = [];
      for (let i = 0; i < 25; i++) {
        events.push(
          makeEvent({
            type: 'queue-operation',
            operation: 'enqueue',
            uuid: `uuid-q-${i}`,
            message: { role: 'user', content: `Task ${i}` },
          })
        );
      }
      const content = toJsonl(...events);

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.queueOperations).toHaveLength(20);
      // Should keep the last 20 (indices 5-24)
      expect(session!.queueOperations![0]!.content).toBe('Task 5');
    });

    it('ignores queue-operation without operation field', () => {
      const content = toJsonl(
        makeEvent({
          type: 'queue-operation',
          // No operation field
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.queueOperations).toBeUndefined();
    });

    it('captures version from queue operation event', () => {
      const content = toJsonl(
        makeEvent({
          type: 'queue-operation',
          operation: 'enqueue',
          version: '1.0.42',
          message: { role: 'user', content: 'do stuff' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.queueOperations![0]!.version).toBe('1.0.42');
    });
  });

  // ── Turn Duration System Events ──

  describe('turn_duration system events', () => {
    it('captures durationMs on the session', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Done',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'uuid-dur',
          durationMs: 1500,
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.lastTurnDurationMs).toBe(1500);
    });

    it('attaches durationMs to the most recent turn metric', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Response',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'uuid-dur-2',
          durationMs: 2500,
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      const lastTurn = session!.performanceMetrics!.recentTurns[0];
      expect(lastTurn!.durationMs).toBe(2500);
    });

    it('computes running average across turns', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Turn 1',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'uuid-d1',
          durationMs: 1000,
        } as Record<string, unknown>),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-a2',
          message: {
            role: 'assistant',
            content: 'Turn 2',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 200,
              output_tokens: 80,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'uuid-d2',
          durationMs: 3000,
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      // Average of 1000 and 3000 = 2000
      expect(session!.avgTurnDurationMs).toBe(2000);
    });

    it('skips zero and negative durationMs values', () => {
      const content = toJsonl(
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: 0,
        } as Record<string, unknown>),
        makeEvent({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'uuid-neg',
          durationMs: -100,
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.lastTurnDurationMs).toBeUndefined();
    });
  });

  // ── Session Metadata Extraction ──

  describe('session metadata extraction', () => {
    it('captures slug (first-write-wins)', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          slug: 'first-slug',
          message: { role: 'user', content: 'Hello' },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-2',
          slug: 'second-slug',
          message: { role: 'user', content: 'Hello again' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.slug).toBe('first-slug');
    });

    it('captures version (first-write-wins)', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          version: '1.0.0',
          message: { role: 'user', content: 'Hello' },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-v2',
          version: '2.0.0',
          message: { role: 'user', content: 'Hello again' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.version).toBe('1.0.0');
    });

    it('captures permissionMode (last-write-wins)', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          permissionMode: 'plan',
          message: { role: 'user', content: 'Hello' },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-pm2',
          permissionMode: 'acceptEdits',
          message: { role: 'user', content: 'Hello again' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.permissionMode).toBe('acceptEdits');
    });

    it('captures isSidechain', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: 'Sidechain event' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.isSidechain).toBe(true);
    });

    it('captures maxThinkingTokens from thinkingMetadata', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          thinkingMetadata: { maxThinkingTokens: 16000 },
          message: { role: 'user', content: 'Think hard' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.maxThinkingTokens).toBe(16000);
    });
  });

  // ── Compaction Enhancements ──

  describe('compaction enhancements', () => {
    it('captures compactedToolIds from microcompact events', () => {
      const content = toJsonl(
        makeEvent({
          type: 'system',
          subtype: 'microcompact_boundary',
          microcompactMetadata: {
            trigger: 'auto',
            preTokens: 50000,
            tokensSaved: 10000,
            compactedToolIds: ['tool-abc', 'tool-def'],
          },
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.performanceMetrics!.compactionEvents).toHaveLength(1);
      expect(session!.performanceMetrics!.compactionEvents[0]!.compactedToolIds).toEqual([
        'tool-abc',
        'tool-def',
      ]);
    });

    it('does not set compactedToolIds for regular compact events', () => {
      const content = toJsonl(
        makeEvent({
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: {
            trigger: 'auto',
            preTokens: 80000,
          },
        } as Record<string, unknown>)
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.performanceMetrics!.compactionEvents[0]!.compactedToolIds).toBeUndefined();
    });
  });

  // ── Tool Invocation Tracking ──

  describe('tool invocation tracking', () => {
    it('tracks tool_use blocks in recentToolInvocations', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentToolInvocations).toHaveLength(1);
      expect(session!.recentToolInvocations![0]!.toolName).toBe('Bash');
      expect(session!.recentToolInvocations![0]!.toolId).toBe('tool-1');
    });

    it('tracks multiple tool invocations across messages', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
          },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-2',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-2', name: 'Edit' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentToolInvocations).toHaveLength(2);
      expect(session!.recentToolInvocations![0]!.toolName).toBe('Bash');
      expect(session!.recentToolInvocations![1]!.toolName).toBe('Edit');
    });

    it('caps ring buffer at 50 invocations', () => {
      const events = [];
      for (let i = 0; i < 55; i++) {
        events.push(
          makeEvent({
            type: 'assistant',
            uuid: `uuid-ti-${i}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `tool-${i}`, name: `Tool${i}` }],
            },
          })
        );
      }
      const content = toJsonl(...events);

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentToolInvocations).toHaveLength(50);
      // Should keep the last 50 (indices 5-54)
      expect(session!.recentToolInvocations![0]!.toolName).toBe('Tool5');
    });

    it('enriches last tool invocation with toolUseResult metadata', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }],
          },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-result',
          toolUseResult: { numFiles: 3, numLines: 150 },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentToolInvocations![0]!.resultNumFiles).toBe(3);
      expect(session!.recentToolInvocations![0]!.resultNumLines).toBe(150);
    });

    it('does not enrich when toolUseResult is a string', () => {
      const content = toJsonl(
        makeEvent({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
          },
        }),
        makeEvent({
          type: 'user',
          uuid: 'uuid-result-str',
          toolUseResult: 'some string result',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.recentToolInvocations![0]!.resultNumFiles).toBeUndefined();
      expect(session!.recentToolInvocations![0]!.resultNumLines).toBeUndefined();
    });
  });

  // ── Topology Node Construction ──

  describe('topology node construction', () => {
    it('creates topology node on first event', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'agent-coder-1',
          message: { role: 'user', content: 'Build feature' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology).toBeDefined();
      expect(session!.topology!.sessionId).toBe('sess-1');
      expect(session!.topology!.agentId).toBe('agent-coder-1');
      expect(session!.topology!.agentType).toBe('coder'); // derived from agentId containing 'cod'
    });

    it('initializes topology with parentSessionId for subagents', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'sub-1',
          message: { role: 'user', content: 'Sub task' },
        })
      );

      const store = new SessionStore();
      parseJsonlFile(
        '/home/user/.claude/sessions/parent-sess/subagents/child.jsonl',
        content,
        0,
        store
      );

      const session = store.getSession('sess-1');
      expect(session!.topology!.parentSessionId).toBe('parent-sess');
    });

    it('syncs topology metrics after each event', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        }),
        makeEvent({
          type: 'assistant',
          uuid: 'uuid-a1',
          message: {
            role: 'assistant',
            content: 'Response',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.turnCount).toBe(1);
      expect(session!.topology!.messageCount).toBe(2);
      expect(session!.topology!.tokenUsage.inputTokens).toBe(100);
    });

    it('marks topology completed on summary event', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Do work' },
        }),
        makeEvent({
          type: 'summary',
          uuid: 'uuid-sum',
          summary: 'All done.',
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.status).toBe('completed');
      expect(session!.topology!.completedAt).toBeDefined();
    });
  });

  // ── deriveAgentType ──

  describe('deriveAgentType', () => {
    it('derives orchestrator from agentId', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'my-orchestrator-agent',
          message: { role: 'user', content: 'Coordinate work' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('orchestrator');
    });

    it('derives planner from agentId', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'planning-agent',
          message: { role: 'user', content: 'Make a plan' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('planner');
    });

    it('derives reviewer from agentId', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'code-reviewer',
          message: { role: 'user', content: 'Review PR' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('reviewer');
    });

    it('derives tester from agentId', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'test-runner',
          message: { role: 'user', content: 'Run tests' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('tester');
    });

    it('derives planner from permissionMode=plan', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          permissionMode: 'plan',
          message: { role: 'user', content: 'Do something' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('planner');
    });

    it('derives coder from tool usage pattern (>40% edit/write)', () => {
      const events: Record<string, unknown>[] = [
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Edit files' },
        }),
      ];
      // 5 Edit tools out of 10 total = 50% > 40% threshold
      for (let i = 0; i < 5; i++) {
        events.push(
          makeEvent({
            type: 'assistant',
            uuid: `uuid-edit-${i}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `edit-${i}`, name: 'Edit' }],
            },
          })
        );
      }
      for (let i = 0; i < 5; i++) {
        events.push(
          makeEvent({
            type: 'assistant',
            uuid: `uuid-read-${i}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read' }],
            },
          })
        );
      }
      const content = toJsonl(...events);

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('coder');
    });

    it('derives tester from tool usage pattern (>50% bash)', () => {
      const events: Record<string, unknown>[] = [
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Run tests' },
        }),
      ];
      // 6 Bash tools out of 10 total = 60% > 50% threshold
      for (let i = 0; i < 6; i++) {
        events.push(
          makeEvent({
            type: 'assistant',
            uuid: `uuid-bash-${i}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `bash-${i}`, name: 'Bash' }],
            },
          })
        );
      }
      for (let i = 0; i < 4; i++) {
        events.push(
          makeEvent({
            type: 'assistant',
            uuid: `uuid-read2-${i}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: `read2-${i}`, name: 'Read' }],
            },
          })
        );
      }
      const content = toJsonl(...events);

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('tester');
    });

    it('derives orchestrator from root session with children', () => {
      // Create parent session first
      const parentContent = toJsonl(
        makeEvent({
          type: 'user',
          sessionId: 'root-sess',
          message: { role: 'user', content: 'Coordinate tasks' },
        })
      );

      // Create child session
      const childContent = toJsonl(
        makeEvent({
          type: 'user',
          sessionId: 'child-sess',
          agentId: 'worker-1',
          message: { role: 'user', content: 'Do sub task' },
        })
      );

      // Send another event on parent after child exists to trigger re-derivation
      const parentUpdate = toJsonl(
        makeEvent({
          type: 'assistant',
          sessionId: 'root-sess',
          uuid: 'uuid-parent-update',
          message: { role: 'assistant', content: 'Coordinating...' },
        })
      );

      const store = new SessionStore();
      parseJsonlFile('/home/user/.claude/projects/abc/root-sess.jsonl', parentContent, 0, store);
      parseJsonlFile(
        '/home/user/.claude/sessions/root-sess/subagents/child.jsonl',
        childContent,
        0,
        store
      );
      // Re-parse parent with new event so deriveAgentType sees children
      parseJsonlFile('/home/user/.claude/projects/abc/root-sess.jsonl', parentUpdate, 0, store);

      const parentSession = store.getSession('root-sess');
      expect(parentSession!.topology!.agentType).toBe('orchestrator');
    });

    it('derives reviewer from goal keyword', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Please review the PR changes' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('reviewer');
    });

    it('derives explorer from goal keyword', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Explore the codebase structure' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('explorer');
    });

    it('derives scanner from goal keyword "lint"', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Run lint on all files' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.topology!.agentType).toBe('scanner');
    });

    it('defaults subagent to coder when no other signals', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          agentId: 'generic-agent', // no type keyword
          message: { role: 'user', content: 'Do generic work' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      // isSubagent is true because agentId is present
      expect(session!.isSubagent).toBe(true);
      expect(session!.topology!.agentType).toBe('coder');
    });

    it('defaults non-subagent to unknown when no signals', () => {
      const content = toJsonl(
        makeEvent({
          type: 'user',
          message: { role: 'user', content: 'Do generic work' },
        })
      );

      const store = parseEvents(content);
      const session = store.getSession('sess-1');
      expect(session!.isSubagent).toBe(false);
      expect(session!.topology!.agentType).toBe('unknown');
    });
  });
});
