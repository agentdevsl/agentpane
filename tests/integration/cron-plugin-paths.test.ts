/**
 * Integration coverage shim for src/lib/events/plugins/cron-plugin.ts.
 * The plugin already has a unit suite; this file exists to lift the
 * combined integration+functional measurement.
 *
 * Run: npx vitest run --project integration tests/integration/cron-plugin-paths.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CronEventSourcePlugin } from '../../src/lib/events/plugins/cron-plugin';

const plugin = new CronEventSourcePlugin();

function tickContext(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sourceName: 'Daily code review',
    config: {
      scheduleType: 'cron',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC',
      lastRunAt: '2026-03-01T09:00:00Z',
    },
    executionCount: 12,
    trigger: 'tick',
    ...overrides,
  });
}

describe('CronEventSourcePlugin (integration coverage shim)', () => {
  describe('verifySignature', () => {
    it('always returns ok(true) (cron has no signature)', async () => {
      const r = await plugin.verifySignature('any', null, 'any');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(true);
    });
  });

  describe('parseEvent', () => {
    it('rejects invalid JSON', () => {
      const r = plugin.parseEvent(new Headers(), 'not-json');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EVENT_PARSE_FAILED');
    });

    it('parses tick context into schedule.tick event', () => {
      const r = plugin.parseEvent(new Headers(), tickContext());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('schedule.tick');
      expect(r.value.action).toBe('tick');
      expect(r.value.source.author).toBe('system');
      expect(r.value.data.scheduleName).toBe('Daily code review');
    });

    it('parses manual context into schedule.manual_trigger event', () => {
      const r = plugin.parseEvent(new Headers(), tickContext({ trigger: 'manual' }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('schedule.manual_trigger');
      expect(r.value.action).toBe('manual');
      expect(typeof r.value.data.body).toBe('string');
      expect(r.value.data.body).toContain('Manual trigger');
    });
  });

  describe('getEventTypes / getTemplateVariables', () => {
    it('lists schedule.tick and schedule.manual_trigger', () => {
      const types = plugin.getEventTypes().map((t) => t.type);
      expect(types).toEqual(['schedule.tick', 'schedule.manual_trigger']);
    });

    it('returns common template variables for any event type', () => {
      const vars = plugin.getTemplateVariables('schedule.tick').map((v) => v.name);
      expect(vars).toContain('schedule.name');
      expect(vars).toContain('event.type');
    });
  });

  describe('matchesFilter', () => {
    function event(action: string | null) {
      return {
        type: 'schedule.tick',
        action,
        deliveryId: 'd-1',
        source: { author: 'system', labels: [] },
        data: {},
        raw: {},
      } as never;
    }

    it('non-action filter fields always match', () => {
      const m = plugin.matchesFilter(event('tick'), {
        field: 'repo',
        operator: 'equals',
        value: 'anything',
      });
      expect(m).toBe(true);
    });

    it('equals on action', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'equals',
          value: 'tick',
        })
      ).toBe(true);
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'equals',
          value: 'manual',
        })
      ).toBe(false);
    });

    it('not_equals on action', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'not_equals',
          value: 'manual',
        })
      ).toBe(true);
    });

    it('contains on action', () => {
      expect(
        plugin.matchesFilter(event('manual_trigger'), {
          field: 'action',
          operator: 'contains',
          value: 'manual',
        })
      ).toBe(true);
      // null action returns false for contains
      expect(
        plugin.matchesFilter(event(null), {
          field: 'action',
          operator: 'contains',
          value: 'manual',
        })
      ).toBe(false);
    });

    it('matches operator with valid regex', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'matches',
          value: '^t.+k$',
        })
      ).toBe(true);
    });

    it('matches operator with invalid regex returns false', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'matches',
          value: '[unclosed',
        })
      ).toBe(false);
    });

    it('matches operator rejects oversized regex (ReDoS guard)', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'matches',
          value: 'a'.repeat(250),
        })
      ).toBe(false);
    });

    it('unknown operator returns false', () => {
      expect(
        plugin.matchesFilter(event('tick'), {
          field: 'action',
          operator: 'wat' as never,
          value: 'tick',
        })
      ).toBe(false);
    });
  });
});
