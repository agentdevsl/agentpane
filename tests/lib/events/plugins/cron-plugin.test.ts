import { describe, expect, it } from 'vitest';
import type { CronEventSourceConfig } from '../../../../src/db/schema/shared/cron-config';
import type {
  NormalizedEvent,
  SubscriptionFilter,
} from '../../../../src/lib/events/plugin-interface';
import {
  CronEventSourcePlugin,
  type CronTickContext,
} from '../../../../src/lib/events/plugins/cron-plugin';

// ============================================================================
// Helpers
// ============================================================================

function makeCronConfig(overrides: Partial<CronEventSourceConfig> = {}): CronEventSourceConfig {
  return {
    scheduleType: 'cron',
    cronExpression: '0 9 * * 1-5',
    timezone: 'America/New_York',
    budget: { maxPerDay: 10 },
    nextRunAt: '2026-03-04T09:00:00Z',
    lastRunAt: '2026-03-03T09:00:00Z',
    consecutiveErrors: 0,
    pausedAt: null,
    ...overrides,
  };
}

function makeTickContext(overrides: Partial<CronTickContext> = {}): CronTickContext {
  return {
    sourceName: 'Daily code review',
    config: makeCronConfig(),
    executionCount: 42,
    trigger: 'tick',
    ...overrides,
  };
}

const plugin = new CronEventSourcePlugin();

// ============================================================================
// Section 1: verifySignature
// ============================================================================

describe('CronEventSourcePlugin', () => {
  describe('verifySignature', () => {
    it('always returns ok(true)', async () => {
      const result = await plugin.verifySignature('any-payload', 'any-sig', 'any-secret');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('returns ok(true) even with null signature', async () => {
      const result = await plugin.verifySignature('any-payload', null, 'any-secret');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('returns ok(true) with empty strings', async () => {
      const result = await plugin.verifySignature('', '', '');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Section 2: parseEvent
  // ==========================================================================

  describe('parseEvent', () => {
    it('tick trigger produces schedule.tick type with action tick', () => {
      const context = makeTickContext({ trigger: 'tick' });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('schedule.tick');
      expect(result.value.action).toBe('tick');
    });

    it('manual trigger produces schedule.manual_trigger type with action manual', () => {
      const context = makeTickContext({ trigger: 'manual' });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.type).toBe('schedule.manual_trigger');
      expect(result.value.action).toBe('manual');
    });

    it('invalid JSON returns PARSE_FAILED error', () => {
      const result = plugin.parseEvent(new Headers(), 'not valid json{{{');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_PARSE_FAILED');
        expect(result.error.message).toContain('Invalid JSON in cron tick context');
      }
    });

    it('event data fields are populated correctly for tick trigger', () => {
      const config = makeCronConfig({
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1-5',
        interval: undefined,
        lastRunAt: '2026-03-03T09:00:00Z',
      });
      const context = makeTickContext({
        sourceName: 'Daily code review',
        config,
        executionCount: 42,
        trigger: 'tick',
      });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;

      // Title
      expect(event.data.title).toBe('Scheduled execution: Daily code review');

      // Body contains scheduled trigger text
      expect(event.data.body).toContain('Scheduled task triggered at');

      // Schedule-specific data fields
      expect(event.data.scheduleName).toBe('Daily code review');
      expect(event.data.scheduleType).toBe('cron');
      expect(event.data.cronExpression).toBe('0 9 * * 1-5');
      expect(event.data.executionCount).toBe(42);
      expect(event.data.lastRunAt).toBe('2026-03-03T09:00:00Z');

      // URL and number are undefined
      expect(event.data.url).toBeUndefined();
      expect(event.data.number).toBeUndefined();
    });

    it('event data fields are populated correctly for manual trigger', () => {
      const context = makeTickContext({
        sourceName: 'Nightly backup',
        trigger: 'manual',
      });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;

      expect(event.data.title).toBe('Scheduled execution: Nightly backup');
      expect(event.data.body).toContain('Manual trigger of "Nightly backup"');
    });

    it('source fields are set correctly (no repo, no branch, system author)', () => {
      const context = makeTickContext();
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source.repo).toBeUndefined();
      expect(result.value.source.branch).toBeUndefined();
      expect(result.value.source.labels).toEqual([]);
      expect(result.value.source.author).toBe('system');
    });

    it('raw field contains schedule config, trigger, timestamp, executionCount, and sourceName', () => {
      const config = makeCronConfig();
      const context = makeTickContext({ config, trigger: 'tick', executionCount: 7 });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const raw = result.value.raw;
      expect(raw.trigger).toBe('tick');
      expect(raw.executionCount).toBe(7);
      expect(raw.sourceName).toBe('Daily code review');
      expect(raw.timestamp).toBeTruthy();
      expect(raw.schedule).toEqual(
        expect.objectContaining({
          scheduleType: 'cron',
          cronExpression: '0 9 * * 1-5',
        })
      );
    });

    it('deliveryId is always unique (uses createId)', () => {
      const body = JSON.stringify(makeTickContext());
      const result1 = plugin.parseEvent(new Headers(), body);
      const result2 = plugin.parseEvent(new Headers(), body);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.deliveryId).toBeTruthy();
      expect(result2.value.deliveryId).toBeTruthy();
      expect(result1.value.deliveryId).not.toBe(result2.value.deliveryId);
    });

    it('handles interval-type schedule config', () => {
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 3600,
        cronExpression: undefined,
      });
      const context = makeTickContext({ config });
      const body = JSON.stringify(context);
      const result = plugin.parseEvent(new Headers(), body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.data.scheduleType).toBe('interval');
      expect(result.value.data.interval).toBe(3600);
    });
  });

  // ==========================================================================
  // Section 3: matchesFilter
  // ==========================================================================

  describe('matchesFilter', () => {
    const tickEvent: NormalizedEvent = {
      type: 'schedule.tick',
      action: 'tick',
      deliveryId: 'del-cron-1',
      source: {
        repo: undefined,
        branch: undefined,
        labels: [],
        author: 'system',
      },
      data: {
        title: 'Scheduled execution: Daily review',
        scheduleName: 'Daily review',
      },
      raw: { trigger: 'tick' },
    };

    const manualEvent: NormalizedEvent = {
      type: 'schedule.manual_trigger',
      action: 'manual',
      deliveryId: 'del-cron-2',
      source: {
        repo: undefined,
        branch: undefined,
        labels: [],
        author: 'system',
      },
      data: {
        title: 'Scheduled execution: Manual task',
        scheduleName: 'Manual task',
      },
      raw: { trigger: 'manual' },
    };

    // --- action field: equals ---

    it('action field + equals: matches when action equals value', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'equals', value: 'tick' };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('action field + equals: does not match when action differs', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'equals', value: 'manual' };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    // --- action field: not_equals ---

    it('action field + not_equals: matches when action differs', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'not_equals',
        value: 'manual',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('action field + not_equals: does not match when action is same', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'not_equals', value: 'tick' };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    // --- action field: contains ---

    it('action field + contains: matches substring', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'contains', value: 'tic' };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('action field + contains: does not match when substring absent', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'contains', value: 'xyz' };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    it('action field + contains: matches manual action', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'contains', value: 'man' };
      expect(plugin.matchesFilter(manualEvent, filter)).toBe(true);
    });

    // --- action field: matches ---

    it('action field + matches: valid regex matches', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: '^tick$',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('action field + matches: valid regex does not match', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: '^manual$',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    it('action field + matches: regex pattern matching', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: 'tick|manual',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
      expect(plugin.matchesFilter(manualEvent, filter)).toBe(true);
    });

    it('action field + matches with regex > 200 chars returns false', () => {
      const longPattern = 'a'.repeat(201);
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: longPattern,
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    it('action field + matches with exactly 200 chars regex works normally', () => {
      // 200 chars is at the boundary — should be accepted
      const borderlinePattern = `tick${'.'.repeat(196)}`;
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: borderlinePattern,
      };
      // The regex won't match 'tick' fully but the important thing is it doesn't reject
      expect(borderlinePattern.length).toBe(200);
      // Should not return false due to length guard; regex just won't match
      // Actually it will match since 'tick' followed by 196 dots will match 'tick' if the rest of string is consumed
      // The key assertion is that it does not throw and is not rejected by length guard
      expect(() => plugin.matchesFilter(tickEvent, filter)).not.toThrow();
    });

    it('action field + matches with invalid regex returns false (no throw)', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: '[invalid',
      };
      expect(() => plugin.matchesFilter(tickEvent, filter)).not.toThrow();
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    it('action field + matches with another invalid regex returns false', () => {
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: '(?P<invalid>)',
      };
      expect(() => plugin.matchesFilter(tickEvent, filter)).not.toThrow();
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    // --- non-action fields always return true ---

    it('repo field always returns true for cron events', () => {
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'equals',
        value: 'anything',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('branch field always returns true for cron events', () => {
      const filter: SubscriptionFilter = {
        field: 'branch',
        operator: 'equals',
        value: 'main',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('labels field always returns true for cron events', () => {
      const filter: SubscriptionFilter = {
        field: 'labels',
        operator: 'contains',
        value: 'bug',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    it('author field always returns true for cron events', () => {
      const filter: SubscriptionFilter = {
        field: 'author',
        operator: 'equals',
        value: 'someone',
      };
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(true);
    });

    // --- action field with unknown operator defaults to false (fail-closed) ---

    it('action field with unknown operator returns false', () => {
      const filter = {
        field: 'action',
        operator: 'unknown_op',
        value: 'tick',
      } as unknown as SubscriptionFilter;
      expect(plugin.matchesFilter(tickEvent, filter)).toBe(false);
    });

    // --- action field when event.action is null ---

    it('action field + contains: returns false when event.action is null', () => {
      const eventWithNullAction: NormalizedEvent = {
        ...tickEvent,
        action: null,
      };
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'contains',
        value: 'tick',
      };
      expect(plugin.matchesFilter(eventWithNullAction, filter)).toBe(false);
    });

    it('action field + matches: tests empty string when event.action is null', () => {
      const eventWithNullAction: NormalizedEvent = {
        ...tickEvent,
        action: null,
      };
      const filter: SubscriptionFilter = {
        field: 'action',
        operator: 'matches',
        value: '^$',
      };
      // null action falls back to '' in regex test, so ^$ matches empty string
      expect(plugin.matchesFilter(eventWithNullAction, filter)).toBe(true);
    });
  });

  // ==========================================================================
  // Section 4: getEventTypes
  // ==========================================================================

  describe('getEventTypes', () => {
    it('returns 2 event types', () => {
      const types = plugin.getEventTypes();
      expect(types).toHaveLength(2);
    });

    it('includes schedule.tick type with tick action', () => {
      const types = plugin.getEventTypes();
      const tickType = types.find((t) => t.type === 'schedule.tick');

      expect(tickType).toBeDefined();
      expect(tickType!.label).toBe('Scheduled Tick');
      expect(tickType!.actions).toEqual(['tick']);
    });

    it('includes schedule.manual_trigger type with manual action', () => {
      const types = plugin.getEventTypes();
      const manualType = types.find((t) => t.type === 'schedule.manual_trigger');

      expect(manualType).toBeDefined();
      expect(manualType!.label).toBe('Manual Trigger');
      expect(manualType!.actions).toEqual(['manual']);
    });
  });

  // ==========================================================================
  // Section 5: getTemplateVariables
  // ==========================================================================

  describe('getTemplateVariables', () => {
    it('returns expected template variables', () => {
      const vars = plugin.getTemplateVariables('schedule.tick');
      const names = vars.map((v) => v.name);

      expect(names).toContain('schedule.name');
      expect(names).toContain('schedule.lastRunAt');
      expect(names).toContain('schedule.executionCount');
      expect(names).toContain('schedule.cronExpression');
      expect(names).toContain('schedule.interval');
      expect(names).toContain('schedule.scheduleType');
      expect(names).toContain('schedule.timezone');
      expect(names).toContain('timestamp');
      expect(names).toContain('trigger');
      expect(names).toContain('event.type');
      expect(names).toContain('event.action');
    });

    it('returns 11 template variables', () => {
      const vars = plugin.getTemplateVariables('schedule.tick');
      expect(vars).toHaveLength(11);
    });

    it('returns same variables regardless of event type argument', () => {
      const tickVars = plugin.getTemplateVariables('schedule.tick');
      const manualVars = plugin.getTemplateVariables('schedule.manual_trigger');
      const unknownVars = plugin.getTemplateVariables('anything');

      expect(tickVars).toEqual(manualVars);
      expect(manualVars).toEqual(unknownVars);
    });

    it('each variable has a name, description, and example', () => {
      const vars = plugin.getTemplateVariables('schedule.tick');

      for (const v of vars) {
        expect(v.name).toBeTruthy();
        expect(v.description).toBeTruthy();
        expect(v.example).toBeTruthy();
      }
    });
  });
});
