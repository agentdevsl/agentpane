import { describe, expect, it, vi } from 'vitest';
import type {
  EventSourcePlugin,
  EventTypeDefinition,
  NormalizedEvent,
  SubscriptionFilter,
  TemplateVariable,
} from '../../../src/lib/events/plugin-interface';

// ============================================================================
// Plugin Interface Contract Tests
// ============================================================================

/**
 * These tests validate the EventSourcePlugin interface contract.
 * Since plugin-interface.ts is pure types (no runtime code),
 * we test that objects conforming to the interface work correctly
 * and verify the type shapes used throughout the event system.
 */

// ============================================================================
// Helpers — Create conforming implementations
// ============================================================================

function createMockPlugin(overrides: Partial<EventSourcePlugin> = {}): EventSourcePlugin {
  return {
    type: 'test',
    verifySignature: vi.fn().mockResolvedValue({ ok: true, value: true }),
    parseEvent: vi.fn().mockReturnValue({
      ok: true,
      value: {
        type: 'push',
        action: null,
        deliveryId: 'delivery-1',
        source: { repo: 'org/repo', branch: 'main' },
        data: { title: 'Push to main' },
        raw: {},
      } satisfies NormalizedEvent,
    }),
    getEventTypes: vi.fn().mockReturnValue([]),
    getTemplateVariables: vi.fn().mockReturnValue([]),
    matchesFilter: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function createNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    type: 'push',
    action: null,
    deliveryId: 'delivery-abc',
    source: {
      repo: 'org/repo',
      branch: 'main',
      labels: ['bug'],
      author: 'user1',
    },
    data: {
      title: 'Test event',
      body: 'Test body',
      url: 'https://github.com/org/repo/pull/1',
      number: 1,
    },
    raw: { full: 'payload' },
    ...overrides,
  };
}

// ============================================================================
// NormalizedEvent Shape Tests
// ============================================================================

describe('NormalizedEvent', () => {
  it('supports all standard fields', () => {
    const event = createNormalizedEvent();

    expect(event.type).toBe('push');
    expect(event.action).toBeNull();
    expect(event.deliveryId).toBe('delivery-abc');
    expect(event.source.repo).toBe('org/repo');
    expect(event.source.branch).toBe('main');
    expect(event.source.labels).toEqual(['bug']);
    expect(event.source.author).toBe('user1');
    expect(event.data.title).toBe('Test event');
    expect(event.data.body).toBe('Test body');
    expect(event.data.url).toContain('github.com');
    expect(event.data.number).toBe(1);
    expect(event.raw).toEqual({ full: 'payload' });
  });

  it('allows action to be a string', () => {
    const event = createNormalizedEvent({ action: 'opened' });
    expect(event.action).toBe('opened');
  });

  it('allows source fields to be undefined', () => {
    const event = createNormalizedEvent({
      source: {},
    });

    expect(event.source.repo).toBeUndefined();
    expect(event.source.branch).toBeUndefined();
    expect(event.source.labels).toBeUndefined();
    expect(event.source.author).toBeUndefined();
  });

  it('allows arbitrary keys in data via index signature', () => {
    const event = createNormalizedEvent({
      data: {
        title: 'Test',
        customField: 'custom-value',
        nested: { deep: true },
      },
    });

    expect(event.data.customField).toBe('custom-value');
    expect(event.data.nested).toEqual({ deep: true });
  });

  it('supports empty raw payload', () => {
    const event = createNormalizedEvent({ raw: {} });
    expect(event.raw).toEqual({});
  });
});

// ============================================================================
// EventTypeDefinition Shape Tests
// ============================================================================

describe('EventTypeDefinition', () => {
  it('has required type, label, and actions', () => {
    const def: EventTypeDefinition = {
      type: 'issues',
      label: 'Issues',
      actions: ['opened', 'closed', 'reopened', 'labeled'],
    };

    expect(def.type).toBe('issues');
    expect(def.label).toBe('Issues');
    expect(def.actions).toHaveLength(4);
    expect(def.actions).toContain('opened');
  });

  it('supports empty actions array', () => {
    const def: EventTypeDefinition = {
      type: 'push',
      label: 'Push',
      actions: [],
    };

    expect(def.actions).toEqual([]);
  });
});

// ============================================================================
// TemplateVariable Shape Tests
// ============================================================================

describe('TemplateVariable', () => {
  it('has name and description', () => {
    const variable: TemplateVariable = {
      name: 'repo',
      description: 'Full repository name (owner/repo)',
    };

    expect(variable.name).toBe('repo');
    expect(variable.description).toContain('repository');
  });

  it('supports optional example', () => {
    const variable: TemplateVariable = {
      name: 'branch',
      description: 'Branch name',
      example: 'main',
    };

    expect(variable.example).toBe('main');
  });

  it('works without example', () => {
    const variable: TemplateVariable = {
      name: 'author',
      description: 'Author of the event',
    };

    expect(variable.example).toBeUndefined();
  });
});

// ============================================================================
// SubscriptionFilter Shape Tests
// ============================================================================

describe('SubscriptionFilter', () => {
  it('supports equals operator', () => {
    const filter: SubscriptionFilter = {
      field: 'repo',
      operator: 'equals',
      value: 'org/repo',
    };

    expect(filter.field).toBe('repo');
    expect(filter.operator).toBe('equals');
    expect(filter.value).toBe('org/repo');
  });

  it('supports contains operator', () => {
    const filter: SubscriptionFilter = {
      field: 'branch',
      operator: 'contains',
      value: 'feature/',
    };

    expect(filter.operator).toBe('contains');
  });

  it('supports matches operator', () => {
    const filter: SubscriptionFilter = {
      field: 'labels',
      operator: 'matches',
      value: 'bug|critical',
    };

    expect(filter.operator).toBe('matches');
  });

  it('supports not_equals operator', () => {
    const filter: SubscriptionFilter = {
      field: 'author',
      operator: 'not_equals',
      value: 'bot',
    };

    expect(filter.operator).toBe('not_equals');
  });

  it('supports action field', () => {
    const filter: SubscriptionFilter = {
      field: 'action',
      operator: 'equals',
      value: 'opened',
    };

    expect(filter.field).toBe('action');
  });
});

// ============================================================================
// EventSourcePlugin Contract Tests
// ============================================================================

describe('EventSourcePlugin', () => {
  it('exposes a type identifier', () => {
    const plugin = createMockPlugin({ type: 'github' });
    expect(plugin.type).toBe('github');
  });

  describe('verifySignature', () => {
    it('returns ok result for valid signature', async () => {
      const plugin = createMockPlugin();
      const result = await plugin.verifySignature('payload', 'sig', 'secret');

      expect(result).toEqual({ ok: true, value: true });
    });

    it('handles null signature', async () => {
      const plugin = createMockPlugin({
        verifySignature: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { message: 'No signature' } }),
      });

      const result = await plugin.verifySignature('payload', null, 'secret');
      expect(result.ok).toBe(false);
    });
  });

  describe('parseEvent', () => {
    it('returns NormalizedEvent on success', () => {
      const plugin = createMockPlugin();
      const result = plugin.parseEvent(new Headers(), '{}');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('push');
        expect(result.value.deliveryId).toBe('delivery-1');
      }
    });

    it('returns error result for invalid payload', () => {
      const plugin = createMockPlugin({
        parseEvent: vi.fn().mockReturnValue({
          ok: false,
          error: { code: 'PARSE_ERROR', message: 'Invalid JSON', status: 400 },
        }),
      });

      const result = plugin.parseEvent(new Headers(), 'invalid');
      expect(result.ok).toBe(false);
    });

    it('receives headers and raw body', () => {
      const parseFn = vi.fn().mockReturnValue({
        ok: true,
        value: createNormalizedEvent(),
      });
      const plugin = createMockPlugin({ parseEvent: parseFn });

      const headers = new Headers({ 'x-github-event': 'push' });
      plugin.parseEvent(headers, '{"action":"push"}');

      expect(parseFn).toHaveBeenCalledWith(headers, '{"action":"push"}');
    });
  });

  describe('getEventTypes', () => {
    it('returns array of event type definitions', () => {
      const plugin = createMockPlugin({
        getEventTypes: vi.fn().mockReturnValue([
          { type: 'push', label: 'Push', actions: [] },
          { type: 'pull_request', label: 'Pull Request', actions: ['opened', 'closed'] },
        ] satisfies EventTypeDefinition[]),
      });

      const types = plugin.getEventTypes();
      expect(types).toHaveLength(2);
      expect(types[0].type).toBe('push');
      expect(types[1].actions).toContain('opened');
    });

    it('can return empty array', () => {
      const plugin = createMockPlugin();
      expect(plugin.getEventTypes()).toEqual([]);
    });
  });

  describe('getTemplateVariables', () => {
    it('returns variables for a given event type', () => {
      const plugin = createMockPlugin({
        getTemplateVariables: vi.fn().mockReturnValue([
          { name: 'repo', description: 'Repository name' },
          { name: 'branch', description: 'Branch name', example: 'main' },
        ] satisfies TemplateVariable[]),
      });

      const vars = plugin.getTemplateVariables('push');
      expect(vars).toHaveLength(2);
      expect(vars[0].name).toBe('repo');
      expect(vars[1].example).toBe('main');
    });
  });

  describe('matchesFilter', () => {
    it('returns true when event matches filter', () => {
      const event = createNormalizedEvent({ source: { repo: 'org/repo' } });
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'equals',
        value: 'org/repo',
      };

      const plugin = createMockPlugin({
        matchesFilter: vi.fn().mockReturnValue(true),
      });

      expect(plugin.matchesFilter(event, filter)).toBe(true);
    });

    it('returns false when event does not match filter', () => {
      const event = createNormalizedEvent({ source: { repo: 'org/other' } });
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'equals',
        value: 'org/repo',
      };

      const plugin = createMockPlugin({
        matchesFilter: vi.fn().mockReturnValue(false),
      });

      expect(plugin.matchesFilter(event, filter)).toBe(false);
    });

    it('receives the event and filter arguments', () => {
      const matchFn = vi.fn().mockReturnValue(true);
      const plugin = createMockPlugin({ matchesFilter: matchFn });

      const event = createNormalizedEvent();
      const filter: SubscriptionFilter = { field: 'branch', operator: 'contains', value: 'main' };

      plugin.matchesFilter(event, filter);

      expect(matchFn).toHaveBeenCalledWith(event, filter);
    });
  });
});

// ============================================================================
// Integration-style: Multiple plugins with different behaviors
// ============================================================================

describe('multiple plugins coexistence', () => {
  it('different plugins can have different types', () => {
    const github = createMockPlugin({ type: 'github' });
    const gitlab = createMockPlugin({ type: 'gitlab' });
    const cron = createMockPlugin({ type: 'cron' });

    expect(github.type).toBe('github');
    expect(gitlab.type).toBe('gitlab');
    expect(cron.type).toBe('cron');
  });

  it('plugins can produce different NormalizedEvent shapes', () => {
    const githubPlugin = createMockPlugin({
      type: 'github',
      parseEvent: vi.fn().mockReturnValue({
        ok: true,
        value: createNormalizedEvent({
          type: 'pull_request',
          action: 'opened',
          source: { repo: 'org/repo', branch: 'feature', author: 'dev1' },
        }),
      }),
    });

    const cronPlugin = createMockPlugin({
      type: 'cron',
      parseEvent: vi.fn().mockReturnValue({
        ok: true,
        value: createNormalizedEvent({
          type: 'schedule.tick',
          action: 'tick',
          source: { author: 'system' },
          data: { title: 'Scheduled run' },
        }),
      }),
    });

    const githubResult = githubPlugin.parseEvent(new Headers(), '{}');
    const cronResult = cronPlugin.parseEvent(new Headers(), '{}');

    if (githubResult.ok && cronResult.ok) {
      expect(githubResult.value.type).toBe('pull_request');
      expect(cronResult.value.type).toBe('schedule.tick');
      expect(githubResult.value.action).toBe('opened');
      expect(cronResult.value.action).toBe('tick');
    }
  });
});
