import { describe, expect, it } from 'vitest';
import {
  canTransition,
  getValidTransitions,
  VALID_TRANSITIONS,
} from '../../src/services/task-transitions';

const ALL_COLUMNS = ['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'] as const;

describe('task-transitions', () => {
  describe('canTransition', () => {
    it('returns true for a valid transition (backlog -> queued)', () => {
      expect(canTransition('backlog', 'queued')).toBe(true);
    });

    it('returns false for self-transitions (backlog -> backlog)', () => {
      expect(canTransition('backlog', 'backlog')).toBe(false);
    });

    it('returns true for all valid (non-self) column pairs', () => {
      for (const from of ALL_COLUMNS) {
        for (const to of ALL_COLUMNS) {
          if (from !== to) {
            expect(canTransition(from, to)).toBe(true);
          }
        }
      }
    });
  });

  describe('getValidTransitions', () => {
    it('returns 4 columns for backlog (excludes self)', () => {
      const transitions = getValidTransitions('backlog');
      expect(transitions).toHaveLength(4);
      expect(transitions).not.toContain('backlog');
    });

    it('returns empty array for an unknown column', () => {
      const transitions = getValidTransitions('nonexistent' as never);
      expect(transitions).toEqual([]);
    });
  });

  describe('VALID_TRANSITIONS', () => {
    it('has entries for all 5 columns', () => {
      for (const column of ALL_COLUMNS) {
        expect(VALID_TRANSITIONS).toHaveProperty(column);
        expect(VALID_TRANSITIONS[column].length).toBeGreaterThan(0);
      }
    });
  });
});
