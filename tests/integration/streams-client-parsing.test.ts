/**
 * Integration tests for the client-side streams parsing and mapping logic.
 *
 * Tests the real parseStreamChunkItems function and Zod validation schemas
 * exported from src/lib/streams/client.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseStreamChunkItems,
  rawChunkDataSchema,
  rawContainerAgentCompleteSchema,
  rawContainerAgentErrorSchema,
  rawContainerAgentStatusSchema,
  rawPresenceDataSchema,
  rawToolCallDataSchema,
  rawTopologyAgentCompletedSchema,
  rawTopologyAgentSpawnedSchema,
} from '../../src/lib/streams/client';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Streams Client Parsing (IT-1750 to IT-1751)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── parseStreamChunkItems ─────────────────────────────────────────────

  describe('parseStreamChunkItems', () => {
    it('IT-1750: empty text returns empty array', () => {
      expect(parseStreamChunkItems('')).toEqual([]);
      expect(parseStreamChunkItems('   ')).toEqual([]);
    });

    it('IT-1752: single JSON object returns array with one item', () => {
      const result = parseStreamChunkItems('{"type":"chunk","data":"hello"}');
      expect(result).toEqual([{ type: 'chunk', data: 'hello' }]);
    });

    it('IT-1753: JSON array returns flattened items', () => {
      const result = parseStreamChunkItems('[{"a":1},{"b":2}]');
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('IT-1754: concatenated JSON arrays are parsed sequentially', () => {
      const result = parseStreamChunkItems('[{"a":1}][{"b":2}]');
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('IT-1755: concatenated arrays with whitespace between', () => {
      const result = parseStreamChunkItems('[{"a":1}]  [{"b":2}]');
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('IT-1756: malformed JSON returns null', () => {
      expect(parseStreamChunkItems('not json at all')).toBeNull();
      expect(parseStreamChunkItems('{incomplete')).toBeNull();
    });

    it('IT-1757: handles escaped quotes in strings', () => {
      const result = parseStreamChunkItems('{"text":"hello \\"world\\""}');
      expect(result).toEqual([{ text: 'hello "world"' }]);
    });

    it('IT-1758: handles nested objects and arrays', () => {
      const result = parseStreamChunkItems('{"data":{"nested":[1,2,3],"obj":{"key":"val"}}}');
      expect(result).toEqual([{ data: { nested: [1, 2, 3], obj: { key: 'val' } } }]);
    });

    it('IT-1759: handles mixed concatenated objects', () => {
      const result = parseStreamChunkItems('{"a":1}{"b":2}');
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });

  // ── Zod schema validation (mapRawEventToTyped input validation) ────────

  describe('mapRawEventToTyped schema validation', () => {
    it('IT-1760: chunk schema accepts valid data', () => {
      const result = rawChunkDataSchema.safeParse({ text: 'hello', agentId: 'agent-1' });
      expect(result.success).toBe(true);
    });

    it('IT-1761: chunk schema provides defaults for missing text', () => {
      const result = rawChunkDataSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.text).toBe('');
      }
    });

    it('IT-1762: tool call schema validates correctly', () => {
      const valid = rawToolCallDataSchema.safeParse({
        id: 'tool-1',
        tool: 'Bash',
        input: { command: 'ls' },
      });
      expect(valid.success).toBe(true);

      // Missing tool defaults to 'unknown'
      const withDefault = rawToolCallDataSchema.safeParse({});
      expect(withDefault.success).toBe(true);
      if (withDefault.success) {
        expect(withDefault.data.tool).toBe('unknown');
      }
    });

    it('IT-1763: presence schema rejects missing userId', () => {
      const result = rawPresenceDataSchema.safeParse({ cursor: { x: 0, y: 0 } });
      expect(result.success).toBe(false);
    });

    it('IT-1764: container-agent:status schema validates stage enum', () => {
      const valid = rawContainerAgentStatusSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        stage: 'running',
        message: 'Running',
      });
      expect(valid.success).toBe(true);

      // Invalid stage
      const invalid = rawContainerAgentStatusSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        stage: 'invalid_stage',
        message: 'Bad',
      });
      expect(invalid.success).toBe(false);
    });

    it('IT-1751: topology:agent_spawned schema validates nullable parentId', () => {
      const withParent = rawTopologyAgentSpawnedSchema.safeParse({
        agentId: 'agent-1',
        name: 'Worker',
        role: 'worker',
        parentId: 'parent-1',
      });
      expect(withParent.success).toBe(true);

      const withNull = rawTopologyAgentSpawnedSchema.safeParse({
        agentId: 'agent-1',
        name: 'Orchestrator',
        role: 'orchestrator',
        parentId: null,
      });
      expect(withNull.success).toBe(true);

      // Missing required fields
      const invalid = rawTopologyAgentSpawnedSchema.safeParse({
        agentId: 'agent-1',
      });
      expect(invalid.success).toBe(false);
    });
  });

  // ── Container agent event schemas ───────────────────────────────────────

  describe('container agent event validation', () => {
    it('IT-1765: container-agent:complete validates status enum', () => {
      const valid = rawContainerAgentCompleteSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'completed',
        turnCount: 5,
      });
      expect(valid.success).toBe(true);

      const turnLimit = rawContainerAgentCompleteSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'turn_limit',
        turnCount: 50,
      });
      expect(turnLimit.success).toBe(true);

      const invalid = rawContainerAgentCompleteSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'unknown_status',
        turnCount: 0,
      });
      expect(invalid.success).toBe(false);
    });

    it('IT-1766: container-agent:error requires error string and turnCount', () => {
      const valid = rawContainerAgentErrorSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        error: 'Something went wrong',
        turnCount: 3,
      });
      expect(valid.success).toBe(true);

      const missingError = rawContainerAgentErrorSchema.safeParse({
        taskId: 'task-1',
        sessionId: 'session-1',
        turnCount: 0,
      });
      expect(missingError.success).toBe(false);
    });

    it('IT-1767: topology:agent_completed validates status enum', () => {
      for (const status of ['completed', 'failed', 'stopped']) {
        const result = rawTopologyAgentCompletedSchema.safeParse({
          agentId: 'agent-1',
          status,
        });
        expect(result.success).toBe(true);
      }

      const invalid = rawTopologyAgentCompletedSchema.safeParse({
        agentId: 'agent-1',
        status: 'running',
      });
      expect(invalid.success).toBe(false);
    });
  });
});
