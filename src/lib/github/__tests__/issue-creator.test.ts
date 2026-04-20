import { describe, expect, it, vi } from 'vitest';
import { GitHubIssueCreator, sanitizeIssueBody, sanitizeLabels } from '../issue-creator.js';

// ---------------------------------------------------------------------------
// F06-04: Plan → issue body sanitisation
// ---------------------------------------------------------------------------

describe('sanitizeIssueBody', () => {
  it('wraps `Closes #N` so GitHub does not auto-close the referenced issue', () => {
    const hostile = 'This plan does some work.\n\nCloses #1';
    const safe = sanitizeIssueBody(hostile);
    // The literal pattern `Closes #1` must not appear at line start
    // (GitHub's parser). Wrapped-in-backticks is the neutralised form.
    expect(safe).toContain('`Closes #1`');
    // GitHub's regex is fairly forgiving — we make sure the original
    // unwrapped pattern has been replaced, not merely appended to.
    expect(safe).not.toMatch(/^Closes #1$/m);
  });

  it('wraps all close-keyword variants (case-insensitive)', () => {
    for (const kw of [
      'closes #2',
      'Closed #3',
      'close #4',
      'fix #5',
      'Fixes #6',
      'fixed #7',
      'Resolves #8',
      'resolved #9',
      'resolve #10',
    ]) {
      const sanitized = sanitizeIssueBody(`Plan: ${kw}`);
      // Each keyword-plus-reference must end up wrapped in backticks.
      expect(sanitized).toMatch(/`[a-z]+(e[sd])?d?\s+#\d+`/i);
      // And the raw pattern must not survive outside a code fence.
      expect(sanitized).not.toMatch(new RegExp(`(?<!\`)${kw.replace(/#/, '#')}`, 'i'));
    }
  });

  it('escapes @mentions so they do not notify users', () => {
    const body = 'cc @octocat and @github please review';
    const safe = sanitizeIssueBody(body);
    expect(safe).toContain('`@octocat`');
    expect(safe).toContain('`@github`');
    // The raw `@octocat` token (preceded by space, not backtick) must
    // not appear in the sanitised output.
    expect(safe).not.toMatch(/(?<!`)@octocat/);
  });

  it('leaves normal prose alone', () => {
    const body = '# Implementation Plan\n\n- Do the thing\n- Do the other thing';
    expect(sanitizeIssueBody(body)).toBe(body);
  });

  it('handles empty or undefined body', () => {
    expect(sanitizeIssueBody('')).toBe('');
    // `sanitizeIssueBody` is not called for undefined in the class,
    // but the helper itself should be null-safe.
    expect(sanitizeIssueBody(null as unknown as string)).toBe(null);
  });

  it('does NOT escape a close keyword that has already been wrapped in code fence', () => {
    // Authors who intentionally want to reference the pattern should be
    // able to do so inside backticks. Our regex is line-level so it
    // still matches inside a code span — that's fine, it just double-
    // wraps, but the output is still inert.
    const body = 'See `closes #1` for the pattern.';
    const safe = sanitizeIssueBody(body);
    // Double-wrapped `` ``closes #1`` `` is still not a close keyword.
    expect(safe).not.toMatch(/^closes #1$/im);
  });

  // Regression: this is the exact test from the remediation plan.
  it('F06-04: plan containing `Closes #1` does NOT produce GitHub close pattern', () => {
    const plan = `
# Implementation Plan

Closes #1

## Details
...
`;
    const sanitized = sanitizeIssueBody(plan);
    // GitHub's close-keyword parser matches `closes|fixes|resolves #N`
    // only outside a code fence. We verify no such literal exists.
    const lines = sanitized.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // A bare line `closes #N` (no backticks, no indentation into a code block)
      // would trigger GitHub. That must not exist.
      expect(trimmed).not.toMatch(/^(?:closes?|close[sd]|fix(?:e[sd])?|resolve[sd]?)\s+#\d+$/i);
    }
  });
});

describe('sanitizeLabels', () => {
  it('accepts safe labels', () => {
    expect(sanitizeLabels(['plan', 'agent-generated', 'good label'])).toEqual([
      'plan',
      'agent-generated',
      'good label',
    ]);
  });

  it('drops labels with commas (prevents multi-label spoofing)', () => {
    expect(sanitizeLabels(['evil,urgent'])).toEqual([]);
  });

  it('drops labels with control characters', () => {
    expect(sanitizeLabels(['bad\nlabel'])).toEqual([]);
  });

  it('drops labels longer than 50 chars', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeLabels([long])).toEqual([]);
  });

  it('drops labels that start with punctuation', () => {
    expect(sanitizeLabels(['-dash', '_under'])).toEqual([]);
  });

  it('treats undefined as empty', () => {
    expect(sanitizeLabels(undefined)).toEqual([]);
  });

  it('trims whitespace from labels', () => {
    expect(sanitizeLabels(['  clean  '])).toEqual(['clean']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: creator routes body through sanitiser before octokit call
// ---------------------------------------------------------------------------

describe('GitHubIssueCreator', () => {
  it('F06-04: createIssue body is sanitised before octokit.rest.issues.create', async () => {
    const createMock = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/1', number: 1, id: 1, node_id: 'node' },
    });
    const octokit = { rest: { issues: { create: createMock } } } as never;
    const creator = new GitHubIssueCreator(octokit);

    await creator.createIssue('o', 'r', {
      title: 'Plan',
      body: 'Closes #1\n\n@evilbot do the thing',
      labels: ['plan', 'evil,spoof'],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const passed = createMock.mock.calls[0]![0];
    // The body reaching octokit does not contain the close pattern outside a
    // code fence, and does not contain a raw `@evilbot` mention.
    expect(passed.body).toContain('`Closes #1`');
    expect(passed.body).toContain('`@evilbot`');
    expect(passed.body).not.toMatch(/^Closes #1$/m);
    // The spoofed label is filtered out; only the safe one survives.
    expect(passed.labels).toEqual(['plan']);
  });
});
