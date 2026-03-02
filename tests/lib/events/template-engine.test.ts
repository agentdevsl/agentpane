import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../../../src/lib/events/plugin-interface';
import { buildTemplateContext, interpolateTemplate } from '../../../src/lib/events/template-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    type: 'issues',
    action: 'opened',
    deliveryId: 'delivery-123',
    source: {
      repo: 'owner/repo',
      author: 'octocat',
      labels: ['bug'],
      ...overrides.source,
    },
    data: {
      title: 'Test issue',
      body: 'Body text',
      url: 'https://github.com/owner/repo/issues/1',
      number: 1,
      ...overrides.data,
    },
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// interpolateTemplate
// ---------------------------------------------------------------------------

describe('interpolateTemplate', () => {
  it('replaces {{variable}} with value from context', () => {
    const result = interpolateTemplate('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('handles nested {{event.type}} dot-notation paths', () => {
    const result = interpolateTemplate('Type: {{event.type}}', {
      event: { type: 'issues' },
    });
    expect(result).toBe('Type: issues');
  });

  it('replaces missing variables with empty string', () => {
    const result = interpolateTemplate('Hello {{missing}}!', {});
    expect(result).toBe('Hello !');
  });

  it('handles {{ spaced.path }} with whitespace inside braces', () => {
    const result = interpolateTemplate('Value: {{ event.type }}', {
      event: { type: 'push' },
    });
    expect(result).toBe('Value: push');
  });

  it('joins array values with ", "', () => {
    const result = interpolateTemplate('Labels: {{labels}}', {
      labels: ['bug', 'enhancement', 'help wanted'],
    });
    expect(result).toBe('Labels: bug, enhancement, help wanted');
  });

  it('truncates values exceeding 4096 chars with "..." suffix', () => {
    const longValue = 'a'.repeat(5000);
    const result = interpolateTemplate('{{value}}', { value: longValue });
    expect(result).toHaveLength(4096 + 3); // 4096 + "..."
    expect(result.endsWith('...')).toBe(true);
    expect(result.slice(0, 4096)).toBe('a'.repeat(4096));
  });

  it('collapses 3+ consecutive newlines to 2', () => {
    const result = interpolateTemplate('{{value}}', {
      value: 'line1\n\n\n\nline2',
    });
    expect(result).toBe('line1\n\nline2');
  });

  it('preserves literal text without placeholders', () => {
    const result = interpolateTemplate('No placeholders here.', {
      unused: 'data',
    });
    expect(result).toBe('No placeholders here.');
  });

  it('returns template unchanged when no placeholders exist', () => {
    const template = 'Static content with no variables';
    const result = interpolateTemplate(template, {});
    expect(result).toBe(template);
  });

  it('handles empty template string', () => {
    const result = interpolateTemplate('', { key: 'value' });
    expect(result).toBe('');
  });

  it('handles multiple placeholders in same template', () => {
    const result = interpolateTemplate('{{greeting}} {{name}}, welcome to {{place}}!', {
      greeting: 'Hello',
      name: 'Alice',
      place: 'Wonderland',
    });
    expect(result).toBe('Hello Alice, welcome to Wonderland!');
  });
});

// ---------------------------------------------------------------------------
// buildTemplateContext
// ---------------------------------------------------------------------------

describe('buildTemplateContext', () => {
  it('maps NormalizedEvent fields to hierarchical namespace', () => {
    const event = makeEvent();
    const ctx = buildTemplateContext(event);

    expect(ctx.event).toEqual({ type: 'issues', action: 'opened' });
    expect(ctx.repo).toEqual({
      name: 'repo',
      full_name: 'owner/repo',
      owner: 'owner',
    });
    expect(ctx.author).toEqual({ login: 'octocat' });
    expect(ctx.delivery_id).toBe('delivery-123');
  });

  it('splits repo full_name "owner/repo" into repo.owner and repo.name', () => {
    const event = makeEvent({ source: { repo: 'my-org/my-repo' } });
    const ctx = buildTemplateContext(event);

    expect((ctx.repo as Record<string, unknown>).owner).toBe('my-org');
    expect((ctx.repo as Record<string, unknown>).name).toBe('my-repo');
    expect((ctx.repo as Record<string, unknown>).full_name).toBe('my-org/my-repo');
  });

  it('handles missing repo (empty string for repo fields)', () => {
    const event = makeEvent({ source: { repo: undefined } });
    const ctx = buildTemplateContext(event);

    const repo = ctx.repo as Record<string, unknown>;
    expect(repo.full_name).toBe('');
    expect(repo.owner).toBe('');
    expect(repo.name).toBe('');
  });

  it('handles repo with nested path "owner/sub/repo"', () => {
    const event = makeEvent({ source: { repo: 'owner/sub/repo' } });
    const ctx = buildTemplateContext(event);

    const repo = ctx.repo as Record<string, unknown>;
    expect(repo.owner).toBe('owner');
    expect(repo.name).toBe('sub/repo');
    expect(repo.full_name).toBe('owner/sub/repo');
  });

  it('defaults optional fields (action, branch, labels, body) to empty strings', () => {
    const event = makeEvent({
      action: null,
      source: { repo: 'owner/repo' },
      data: { title: 'Test' },
    });
    const ctx = buildTemplateContext(event);

    expect((ctx.event as Record<string, unknown>).action).toBe('');
    expect((ctx.pr as Record<string, unknown>).branch).toBe('');
    expect((ctx.issue as Record<string, unknown>).labels).toBe('');
    expect((ctx.issue as Record<string, unknown>).body).toBe('');
  });

  it('maps both issue and pr namespaces from shared event.data fields', () => {
    const event = makeEvent({
      source: { repo: 'owner/repo', branch: 'feature-branch', labels: ['bug', 'urgent'] },
      data: {
        title: 'Fix the bug',
        body: 'Description here',
        url: 'https://github.com/owner/repo/pull/42',
        number: 42,
        base_branch: 'main',
      },
    });
    const ctx = buildTemplateContext(event);

    const issue = ctx.issue as Record<string, unknown>;
    expect(issue.title).toBe('Fix the bug');
    expect(issue.body).toBe('Description here');
    expect(issue.number).toBe(42);
    expect(issue.url).toBe('https://github.com/owner/repo/pull/42');
    expect(issue.labels).toBe('bug, urgent');

    const pr = ctx.pr as Record<string, unknown>;
    expect(pr.title).toBe('Fix the bug');
    expect(pr.body).toBe('Description here');
    expect(pr.number).toBe(42);
    expect(pr.url).toBe('https://github.com/owner/repo/pull/42');
    expect(pr.branch).toBe('feature-branch');
    expect(pr.base_branch).toBe('main');
  });

  it('sets delivery_id from event.deliveryId', () => {
    const event = makeEvent({ deliveryId: 'abc-xyz-789' });
    const ctx = buildTemplateContext(event);

    expect(ctx.delivery_id).toBe('abc-xyz-789');
  });
});
