import type { NormalizedEvent } from './plugin-interface.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length of a single interpolated value after sanitization. */
const MAX_VALUE_LENGTH = 4096;

/** Pattern matching {{variable.path}} placeholders. */
const TEMPLATE_PATTERN = /\{\{(\s*[\w.]+\s*)\}\}/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interpolate `{{variable}}` placeholders in a template string.
 *
 * - Supports dot-notation paths (e.g. `{{issue.title}}`)
 * - Missing variables are replaced with an empty string
 * - Array values are joined with ", "
 * - Output is sanitized to prevent markdown injection
 */
export function interpolateTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PATTERN, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const value = resolvePath(variables, path);
    return sanitizeValue(formatValue(value));
  });
}

/**
 * Build the template variable context from a NormalizedEvent.
 *
 * Maps the flat NormalizedEvent structure into the hierarchical namespace
 * used by templates: event.*, repo.*, issue.*, pr.*, author.*, delivery_id.
 */
export function buildTemplateContext(event: NormalizedEvent): Record<string, unknown> {
  const repoFullName = event.source.repo ?? '';
  const repoParts = repoFullName.split('/');
  const repoOwner = repoParts[0] ?? '';
  const repoName = repoParts.slice(1).join('/') || repoFullName;

  return {
    event: {
      type: event.type,
      action: event.action ?? '',
    },
    repo: {
      name: repoName,
      full_name: repoFullName,
      owner: repoOwner,
    },
    issue: {
      title: event.data.title ?? '',
      body: event.data.body ?? '',
      number: event.data.number ?? '',
      url: event.data.url ?? '',
      labels: event.source.labels?.join(', ') ?? '',
    },
    pr: {
      title: event.data.title ?? '',
      body: event.data.body ?? '',
      number: event.data.number ?? '',
      url: event.data.url ?? '',
      branch: event.source.branch ?? '',
      base_branch: event.data.base_branch ?? '',
    },
    author: {
      login: event.source.author ?? '',
    },
    delivery_id: event.deliveryId,
    // Schedule-specific variables (populated by cron plugin)
    schedule: {
      name: event.data.scheduleName ?? '',
      lastRunAt: event.data.lastRunAt ?? '',
      executionCount: event.data.executionCount ?? '',
      cronExpression: event.data.cronExpression ?? '',
      interval: event.data.interval ?? '',
      scheduleType: event.data.scheduleType ?? '',
      timezone: (event.raw?.schedule as Record<string, unknown>)?.timezone ?? '',
    },
    timestamp: event.raw?.timestamp ?? '',
    trigger: event.raw?.trigger ?? '',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk a dot-notation path through a nested object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Convert an arbitrary value to a display string.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(String).join(', ');
  }

  return String(value);
}

/**
 * Sanitize an interpolated value to prevent markdown injection.
 * Collapses runs of 3+ newlines into 2 and truncates to MAX_VALUE_LENGTH.
 */
function sanitizeValue(value: string): string {
  const collapsed = value.replace(/\n{3,}/g, '\n\n');
  if (collapsed.length > MAX_VALUE_LENGTH) {
    return `${collapsed.slice(0, MAX_VALUE_LENGTH)}...`;
  }
  return collapsed;
}
