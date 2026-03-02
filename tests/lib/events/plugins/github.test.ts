import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  NormalizedEvent,
  SubscriptionFilter,
} from '../../../../src/lib/events/plugin-interface';
import { GitHubEventSourcePlugin } from '../../../../src/lib/events/plugins/github';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a real HMAC-SHA256 signature in the format GitHub sends:
 *   sha256=<hex digest>
 */
function computeGitHubSignature(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Build a minimal Headers object with the required GitHub webhook headers.
 */
function makeHeaders(eventType: string, deliveryId: string): Headers {
  const headers = new Headers();
  headers.set('x-github-event', eventType);
  headers.set('x-github-delivery', deliveryId);
  return headers;
}

const plugin = new GitHubEventSourcePlugin();

// ============================================================================
// Section 1: verifySignature
// ============================================================================

describe('GitHubEventSourcePlugin', () => {
  describe('verifySignature', () => {
    const secret = 'test-webhook-secret';
    const payload = JSON.stringify({ action: 'opened', issue: { title: 'Hello' } });

    it('valid signature returns ok(true)', async () => {
      const signature = computeGitHubSignature(payload, secret);
      const result = await plugin.verifySignature(payload, signature, secret);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('tampered payload returns err', async () => {
      const signature = computeGitHubSignature(payload, secret);
      const tampered = payload + 'TAMPERED';
      const result = await plugin.verifySignature(tampered, signature, secret);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');
      }
    });

    it('null signature returns err', async () => {
      const result = await plugin.verifySignature(payload, null, secret);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');
      }
    });

    it('wrong secret returns err', async () => {
      const signature = computeGitHubSignature(payload, secret);
      const result = await plugin.verifySignature(payload, signature, 'wrong-secret');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');
      }
    });
  });

  // ==========================================================================
  // Section 2: parseEvent
  // ==========================================================================

  describe('parseEvent', () => {
    it('parses issues event: extracts title, body, url, number, labels, author', () => {
      const headers = makeHeaders('issues', 'delivery-001');
      const body = JSON.stringify({
        action: 'opened',
        issue: {
          title: 'Bug: login fails',
          body: 'Steps to reproduce...',
          html_url: 'https://github.com/owner/repo/issues/42',
          number: 42,
          labels: [{ name: 'bug' }, { name: 'priority:high' }],
          user: { login: 'reporter' },
        },
        repository: { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } },
        sender: { login: 'octocat' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;
      expect(event.type).toBe('issues');
      expect(event.action).toBe('opened');
      expect(event.deliveryId).toBe('delivery-001');
      expect(event.source.repo).toBe('owner/repo');
      expect(event.source.labels).toEqual(['bug', 'priority:high']);
      expect(event.source.author).toBe('octocat');
      expect(event.data.title).toBe('Bug: login fails');
      expect(event.data.body).toBe('Steps to reproduce...');
      expect(event.data.url).toBe('https://github.com/owner/repo/issues/42');
      expect(event.data.number).toBe(42);
    });

    it('parses pull_request event: extracts branch info', () => {
      const headers = makeHeaders('pull_request', 'delivery-002');
      const body = JSON.stringify({
        action: 'opened',
        pull_request: {
          title: 'Fix login bug',
          body: 'This PR fixes...',
          html_url: 'https://github.com/owner/repo/pull/99',
          number: 99,
          head: { ref: 'fix/login-bug' },
          base: { ref: 'main' },
          labels: [{ name: 'enhancement' }],
          user: { login: 'dev' },
          merged: false,
        },
        repository: { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } },
        sender: { login: 'dev' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;
      expect(event.type).toBe('pull_request');
      expect(event.action).toBe('opened');
      expect(event.source.branch).toBe('fix/login-bug');
      expect(event.data.base_branch).toBe('main');
      expect(event.data.title).toBe('Fix login bug');
      expect(event.data.number).toBe(99);
      expect(event.source.labels).toEqual(['enhancement']);
    });

    it('normalizes PR action="closed" with merged=true to action="merged"', () => {
      const headers = makeHeaders('pull_request', 'delivery-003');
      const body = JSON.stringify({
        action: 'closed',
        pull_request: {
          title: 'Merged PR',
          merged: true,
          head: { ref: 'feature/x' },
          base: { ref: 'main' },
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'dev' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.action).toBe('merged');
    });

    it('keeps PR action="closed" with merged=false as action="closed"', () => {
      const headers = makeHeaders('pull_request', 'delivery-004');
      const body = JSON.stringify({
        action: 'closed',
        pull_request: {
          title: 'Closed PR',
          merged: false,
          head: { ref: 'feature/y' },
          base: { ref: 'main' },
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'dev' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.action).toBe('closed');
    });

    it('parses push event: extracts branch from refs/heads/main', () => {
      const headers = makeHeaders('push', 'delivery-005');
      const body = JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } },
        sender: { login: 'pusher' },
        head_commit: {
          message: 'chore: update deps',
          url: 'https://github.com/owner/repo/commit/abc123',
        },
        commits: [{ message: 'chore: update deps' }],
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;
      expect(event.type).toBe('push');
      expect(event.action).toBeNull();
      expect(event.source.branch).toBe('main');
      expect(event.source.repo).toBe('owner/repo');
      expect(event.source.author).toBe('pusher');
      expect(event.data.title).toBe('chore: update deps');
      expect(event.data.url).toBe('https://github.com/owner/repo/commit/abc123');
    });

    it('parses push event with non-standard ref preserves raw ref', () => {
      const headers = makeHeaders('push', 'delivery-006');
      const body = JSON.stringify({
        ref: 'refs/tags/v1.0.0',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'tagger' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // refs/tags/v1.0.0 does not start with refs/heads/ so the raw ref is preserved
      expect(result.value.source.branch).toBe('refs/tags/v1.0.0');
    });

    it('parses ping event (generic handler)', () => {
      const headers = makeHeaders('ping', 'delivery-007');
      const body = JSON.stringify({
        zen: 'Anything added dilutes everything else.',
        hook_id: 12345,
        repository: { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } },
        sender: { login: 'github' },
      });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const event = result.value;
      expect(event.type).toBe('ping');
      expect(event.action).toBeNull();
      expect(event.source.repo).toBe('owner/repo');
      expect(event.source.author).toBe('github');
      expect(event.data).toEqual({});
    });

    it('returns PARSE_FAILED when x-github-event header missing', () => {
      const headers = new Headers();
      headers.set('x-github-delivery', 'delivery-008');
      const body = JSON.stringify({ action: 'opened' });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_PARSE_FAILED');
        expect(result.error.message).toContain('Missing required GitHub webhook headers');
      }
    });

    it('returns PARSE_FAILED when x-github-delivery header missing', () => {
      const headers = new Headers();
      headers.set('x-github-event', 'issues');
      const body = JSON.stringify({ action: 'opened' });

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_PARSE_FAILED');
        expect(result.error.message).toContain('Missing required GitHub webhook headers');
      }
    });

    it('returns PARSE_FAILED for invalid JSON body', () => {
      const headers = makeHeaders('issues', 'delivery-009');
      const body = 'this is not valid JSON{{{';

      const result = plugin.parseEvent(headers, body);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EVENT_PARSE_FAILED');
        expect(result.error.message).toContain('Invalid JSON body');
      }
    });
  });

  // ==========================================================================
  // Section 3: matchesFilter
  // ==========================================================================

  describe('matchesFilter', () => {
    const testEvent: NormalizedEvent = {
      type: 'issues',
      action: 'opened',
      deliveryId: 'del-1',
      source: {
        repo: 'owner/my-repo',
        branch: 'feature/test',
        labels: ['bug', 'priority:high'],
        author: 'octocat',
      },
      data: { title: 'Test' },
      raw: {},
    };

    // --- equals ---

    it('equals on string field: matches exact repo', () => {
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'equals',
        value: 'owner/my-repo',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('equals on array field: matches when any label equals value', () => {
      const filter: SubscriptionFilter = { field: 'labels', operator: 'equals', value: 'bug' };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('equals: does not match different value', () => {
      const filter: SubscriptionFilter = { field: 'repo', operator: 'equals', value: 'other/repo' };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(false);
    });

    // --- not_equals ---

    it('not_equals on string: true when value differs', () => {
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'not_equals',
        value: 'other/repo',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('not_equals on array: true when no element matches', () => {
      const filter: SubscriptionFilter = {
        field: 'labels',
        operator: 'not_equals',
        value: 'feature',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    // --- contains ---

    it('contains on string: substring match', () => {
      const filter: SubscriptionFilter = { field: 'repo', operator: 'contains', value: 'my-repo' };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('contains on array: substring match on any element', () => {
      const filter: SubscriptionFilter = {
        field: 'labels',
        operator: 'contains',
        value: 'priority',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    // --- matches ---

    it('matches with valid regex: matches pattern', () => {
      const filter: SubscriptionFilter = {
        field: 'repo',
        operator: 'matches',
        value: '^owner/.*-repo$',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('matches with regex on array: matches any element', () => {
      const filter: SubscriptionFilter = {
        field: 'labels',
        operator: 'matches',
        value: 'priority:\\w+',
      };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });

    it('matches with pattern > 200 chars: returns false (ReDoS guard)', () => {
      const longPattern = 'a'.repeat(201);
      const filter: SubscriptionFilter = { field: 'repo', operator: 'matches', value: longPattern };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(false);
    });

    it('matches with invalid regex (e.g., "[invalid"): returns false, no throw', () => {
      const filter: SubscriptionFilter = { field: 'repo', operator: 'matches', value: '[invalid' };
      expect(() => plugin.matchesFilter(testEvent, filter)).not.toThrow();
      expect(plugin.matchesFilter(testEvent, filter)).toBe(false);
    });

    // --- edge cases ---

    it('unknown field: returns false', () => {
      // Cast to bypass type checking for an unknown field
      const filter = {
        field: 'unknown_field',
        operator: 'equals',
        value: 'anything',
      } as SubscriptionFilter;
      expect(plugin.matchesFilter(testEvent, filter)).toBe(false);
    });

    it('action field: matches event.action', () => {
      const filter: SubscriptionFilter = { field: 'action', operator: 'equals', value: 'opened' };
      expect(plugin.matchesFilter(testEvent, filter)).toBe(true);
    });
  });

  // ==========================================================================
  // Section 4: getEventTypes / getTemplateVariables
  // ==========================================================================

  describe('getEventTypes', () => {
    it('returns 4 event types', () => {
      const types = plugin.getEventTypes();
      expect(types).toHaveLength(4);

      const typeNames = types.map((t) => t.type);
      expect(typeNames).toContain('issues');
      expect(typeNames).toContain('pull_request');
      expect(typeNames).toContain('push');
      expect(typeNames).toContain('ping');
    });
  });

  describe('getTemplateVariables', () => {
    it('issues includes issue-specific vars', () => {
      const vars = plugin.getTemplateVariables('issues');
      const names = vars.map((v) => v.name);

      expect(names).toContain('issue.title');
      expect(names).toContain('issue.body');
      expect(names).toContain('issue.number');
      expect(names).toContain('issue.url');
      expect(names).toContain('issue.labels');
      // Also includes common vars
      expect(names).toContain('event.type');
      expect(names).toContain('repo.full_name');
    });

    it('pull_request includes PR-specific vars', () => {
      const vars = plugin.getTemplateVariables('pull_request');
      const names = vars.map((v) => v.name);

      expect(names).toContain('pr.title');
      expect(names).toContain('pr.body');
      expect(names).toContain('pr.number');
      expect(names).toContain('pr.url');
      expect(names).toContain('pr.branch');
      expect(names).toContain('pr.base_branch');
      // Also includes common vars
      expect(names).toContain('event.type');
      expect(names).toContain('author.login');
    });

    it('unknown event type returns common vars', () => {
      const vars = plugin.getTemplateVariables('unknown');
      const names = vars.map((v) => v.name);

      expect(names).toContain('event.type');
      expect(names).toContain('event.action');
      expect(names).toContain('repo.name');
      expect(names).toContain('repo.full_name');
      expect(names).toContain('author.login');
      expect(names).toContain('delivery_id');
      // Should NOT contain issue or PR specific vars
      expect(names).not.toContain('issue.title');
      expect(names).not.toContain('pr.title');
    });
  });
});
