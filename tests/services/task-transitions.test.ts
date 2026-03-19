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

    it('returns true for all defined valid transitions', () => {
      const expectedValid: Array<[string, string]> = [
        ['backlog', 'queued'],
        ['backlog', 'in_progress'],
        ['queued', 'in_progress'],
        ['queued', 'backlog'],
        ['in_progress', 'waiting_approval'],
        ['in_progress', 'backlog'],
        ['waiting_approval', 'verified'],
        ['waiting_approval', 'in_progress'],
        ['waiting_approval', 'backlog'],
        ['verified', 'backlog'],
      ];

      for (const [from, to] of expectedValid) {
        expect(canTransition(from as never, to as never)).toBe(true);
      }
    });

    it('returns false for invalid transitions', () => {
      const expectedInvalid: Array<[string, string]> = [
        ['backlog', 'waiting_approval'],
        ['backlog', 'verified'],
        ['queued', 'waiting_approval'],
        ['queued', 'verified'],
        ['in_progress', 'queued'],
        ['in_progress', 'verified'],
        ['verified', 'queued'],
        ['verified', 'in_progress'],
        ['verified', 'waiting_approval'],
      ];

      for (const [from, to] of expectedInvalid) {
        expect(canTransition(from as never, to as never)).toBe(false);
      }
    });
  });

  describe('getValidTransitions', () => {
    it('returns 2 columns for backlog (queued and in_progress)', () => {
      const transitions = getValidTransitions('backlog');
      expect(transitions).toHaveLength(2);
      expect(transitions).toEqual(['queued', 'in_progress']);
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
