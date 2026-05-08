/**
 * Integration coverage for src/lib/events/plugins/github.ts.
 *
 * Note: this module already has a comprehensive unit test suite at
 * `tests/lib/events/plugins/github.test.ts` (≈500 lines). This file exists
 * solely to lift coverage in the integration project's measurement so the
 * combined integration+functional report doesn't show the file as 0%.
 *
 * Run: npx vitest run --project integration tests/integration/github-plugin-paths.test.ts
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubEventSourcePlugin } from '../../src/lib/events/plugins/github';

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function makeHeaders(eventType: string, deliveryId = 'delivery-1'): Headers {
  const h = new Headers();
  h.set('x-github-event', eventType);
  h.set('x-github-delivery', deliveryId);
  return h;
}

describe('GitHubEventSourcePlugin (integration coverage shim)', () => {
  const plugin = new GitHubEventSourcePlugin();

  describe('verifySignature', () => {
    it('valid signature returns ok(true)', async () => {
      const payload = JSON.stringify({ ok: 1 });
      const sig = sign(payload, 'secret');
      const r = await plugin.verifySignature(payload, sig, 'secret');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(true);
    });

    it('tampered payload returns err with SIGNATURE_INVALID', async () => {
      const payload = JSON.stringify({ ok: 1 });
      const sig = sign(payload, 'secret');
      const r = await plugin.verifySignature(`${payload}TAMPERED`, sig, 'secret');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EVENT_SIGNATURE_INVALID');
    });

    it('missing signature returns err', async () => {
      const r = await plugin.verifySignature('{}', null, 'secret');
      expect(r.ok).toBe(false);
    });
  });

  describe('parseEvent', () => {
    it('rejects payload missing required headers', () => {
      const headers = new Headers();
      const r = plugin.parseEvent(headers, '{}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EVENT_PARSE_FAILED');
    });

    it('rejects invalid JSON body', () => {
      const r = plugin.parseEvent(makeHeaders('issues'), '{not json');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EVENT_PARSE_FAILED');
    });

    it('parses an issues opened event into NormalizedEvent', () => {
      const payload = JSON.stringify({
        action: 'opened',
        issue: {
          title: 'Bug: login fails',
          body: 'Steps...',
          html_url: 'https://github.com/owner/repo/issues/42',
          number: 42,
          labels: [{ name: 'bug' }, { name: 'priority:high' }],
          user: { login: 'octocat' },
        },
        repository: {
          full_name: 'owner/repo',
          name: 'repo',
          owner: { login: 'owner' },
        },
        sender: { login: 'octocat' },
      });
      const r = plugin.parseEvent(makeHeaders('issues'), payload);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('issues');
      expect(r.value.action).toBe('opened');
      expect(r.value.deliveryId).toBe('delivery-1');
    });

    it('parses a pull_request event', () => {
      const payload = JSON.stringify({
        action: 'opened',
        pull_request: {
          title: 'Fix login',
          body: 'PR body',
          html_url: 'https://github.com/owner/repo/pull/9',
          number: 9,
          head: { ref: 'fix/login' },
          base: { ref: 'main' },
          labels: [{ name: 'bug' }],
          user: { login: 'octocat' },
          merged: false,
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
      });
      const r = plugin.parseEvent(makeHeaders('pull_request'), payload);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('pull_request');
    });

    it('parses a push event', () => {
      const payload = JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
        head_commit: {
          message: 'feat: add thing',
          url: 'https://github.com/owner/repo/commit/abc',
        },
        commits: [{ message: 'a' }, { message: 'b' }],
      });
      const r = plugin.parseEvent(makeHeaders('push'), payload);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('push');
    });

    it('parses a ping event', () => {
      const payload = JSON.stringify({
        zen: 'Ship it',
        hook_id: 999,
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
      });
      const r = plugin.parseEvent(makeHeaders('ping'), payload);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe('ping');
    });
  });

  describe('getEventTypes / getTemplateVariables', () => {
    it('returns all four supported types', () => {
      const types = plugin.getEventTypes().map((t) => t.type);
      expect(types).toContain('issues');
      expect(types).toContain('pull_request');
      expect(types).toContain('push');
      expect(types).toContain('ping');
    });

    it('returns issue-specific variables for issues', () => {
      const vars = plugin.getTemplateVariables('issues').map((v) => v.name);
      expect(vars).toContain('issue.title');
      expect(vars).toContain('issue.number');
    });

    it('returns PR-specific variables for pull_request', () => {
      const vars = plugin.getTemplateVariables('pull_request').map((v) => v.name);
      expect(vars).toContain('pr.title');
      expect(vars).toContain('pr.branch');
    });

    it('falls back to common variables for unknown event type', () => {
      const vars = plugin.getTemplateVariables('made-up').map((v) => v.name);
      expect(vars).toContain('event.type');
      expect(vars).not.toContain('issue.title');
    });
  });

  describe('matchesFilter', () => {
    function asEvent(overrides: Record<string, unknown> = {}) {
      return {
        type: 'issues',
        action: 'opened',
        deliveryId: 'd-1',
        source: {
          repo: 'owner/repo',
          author: 'octocat',
          labels: ['bug', 'priority:high'],
        },
        data: {},
        raw: {},
        ...overrides,
      } as never;
    }

    it('equals matches scalar field (action)', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'action',
        operator: 'equals',
        value: 'opened',
      });
      expect(m).toBe(true);
    });

    it('equals matches array field by membership (labels)', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'labels',
        operator: 'equals',
        value: 'bug',
      });
      expect(m).toBe(true);
    });

    it('not_equals matches scalar field', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'action',
        operator: 'not_equals',
        value: 'closed',
      });
      expect(m).toBe(true);
    });

    it('not_equals on labels returns false when label is present', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'labels',
        operator: 'not_equals',
        value: 'bug',
      });
      expect(m).toBe(false);
    });

    it('contains matches substring on string field', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'repo',
        operator: 'contains',
        value: 'owner',
      });
      expect(m).toBe(true);
    });

    it('contains matches substring inside an array entry', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'labels',
        operator: 'contains',
        value: 'priority',
      });
      expect(m).toBe(true);
    });

    it('matches operator handles valid regex', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'repo',
        operator: 'matches',
        value: '^owner/.*$',
      });
      expect(m).toBe(true);
    });

    it('matches operator returns false for invalid regex', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'repo',
        operator: 'matches',
        value: '[unclosed',
      });
      expect(m).toBe(false);
    });

    it('matches operator rejects oversized regex pattern (ReDoS guard)', () => {
      const huge = 'a'.repeat(250);
      const m = plugin.matchesFilter(asEvent(), {
        field: 'repo',
        operator: 'matches',
        value: huge,
      });
      expect(m).toBe(false);
    });

    it('returns false for unknown operator', () => {
      const m = plugin.matchesFilter(asEvent(), {
        field: 'action',
        operator: 'wat' as never,
        value: 'opened',
      });
      expect(m).toBe(false);
    });

    it('returns false when field resolves to undefined', () => {
      const m = plugin.matchesFilter(asEvent({ source: {} }), {
        field: 'repo',
        operator: 'equals',
        value: 'anything',
      });
      expect(m).toBe(false);
    });
  });
});
