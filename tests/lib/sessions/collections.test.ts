/**
 * Tests for session collections module
 *
 * Covers:
 * - Collection creation and structure
 * - sessionCollections registry
 * - clearSessionCollections
 * - getCollectionStats
 */
import { describe, expect, it, vi } from 'vitest';

// Mock @tanstack/db before importing the module under test.
// vi.mock factories are hoisted, so we cannot reference outer variables.
vi.mock('@tanstack/db', () => ({
  createCollection: vi.fn((opts: { id: string }) => ({
    id: opts.id,
    size: 0,
    isReady: () => true,
    toArray: [],
    delete: vi.fn(),
  })),
  localOnlyCollectionOptions: vi.fn((opts: unknown) => opts),
}));

// Now import the module under test
import {
  agentStateCollection,
  chunksCollection,
  clearSessionCollections,
  getCollectionStats,
  messagesCollection,
  presenceCollection,
  sessionCollections,
  terminalCollection,
  toolCallsCollection,
  workflowCollection,
} from '../../../src/lib/sessions/collections';

describe('Session Collections', () => {
  // ── Individual Collections ──

  describe('individual collections', () => {
    it('chunksCollection is defined', () => {
      expect(chunksCollection).toBeDefined();
    });

    it('toolCallsCollection is defined', () => {
      expect(toolCallsCollection).toBeDefined();
    });

    it('presenceCollection is defined', () => {
      expect(presenceCollection).toBeDefined();
    });

    it('terminalCollection is defined', () => {
      expect(terminalCollection).toBeDefined();
    });

    it('workflowCollection is defined', () => {
      expect(workflowCollection).toBeDefined();
    });

    it('agentStateCollection is defined', () => {
      expect(agentStateCollection).toBeDefined();
    });

    it('messagesCollection is defined', () => {
      expect(messagesCollection).toBeDefined();
    });
  });

  // ── Session Collections Registry ──

  describe('sessionCollections registry', () => {
    it('has all 7 collection keys', () => {
      const keys = Object.keys(sessionCollections);
      expect(keys).toHaveLength(7);
      expect(keys).toContain('chunks');
      expect(keys).toContain('toolCalls');
      expect(keys).toContain('presence');
      expect(keys).toContain('terminal');
      expect(keys).toContain('workflow');
      expect(keys).toContain('agentState');
      expect(keys).toContain('messages');
    });

    it('maps to the correct collection objects', () => {
      expect(sessionCollections.chunks).toBe(chunksCollection);
      expect(sessionCollections.toolCalls).toBe(toolCallsCollection);
      expect(sessionCollections.presence).toBe(presenceCollection);
      expect(sessionCollections.terminal).toBe(terminalCollection);
      expect(sessionCollections.workflow).toBe(workflowCollection);
      expect(sessionCollections.agentState).toBe(agentStateCollection);
      expect(sessionCollections.messages).toBe(messagesCollection);
    });
  });

  // ── clearSessionCollections ──

  describe('clearSessionCollections', () => {
    it('is a function', () => {
      expect(typeof clearSessionCollections).toBe('function');
    });

    it('does not throw', () => {
      expect(() => clearSessionCollections()).not.toThrow();
    });

    it('completes without error', () => {
      expect(() => clearSessionCollections()).not.toThrow();
    });
  });

  // ── getCollectionStats ──

  describe('getCollectionStats', () => {
    it('returns stats for all 7 collections', () => {
      const stats = getCollectionStats();
      const keys = Object.keys(stats);
      expect(keys).toHaveLength(7);
      expect(keys).toContain('chunks');
      expect(keys).toContain('toolCalls');
      expect(keys).toContain('presence');
      expect(keys).toContain('terminal');
      expect(keys).toContain('workflow');
      expect(keys).toContain('agentState');
      expect(keys).toContain('messages');
    });

    it('each stat entry has size and ready fields', () => {
      const stats = getCollectionStats();
      for (const [, stat] of Object.entries(stats)) {
        expect(stat).toHaveProperty('size');
        expect(stat).toHaveProperty('ready');
        expect(typeof stat.size).toBe('number');
        expect(typeof stat.ready).toBe('boolean');
      }
    });

    it('returns size 0 for fresh collections', () => {
      const stats = getCollectionStats();
      for (const [, stat] of Object.entries(stats)) {
        expect(stat.size).toBe(0);
      }
    });
  });
});
