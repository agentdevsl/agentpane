import type { AppError } from '../../errors/base.js';
import { EventErrors } from '../../errors/event-errors.js';
import { verifyWebhookSignature } from '../../github/webhooks.js';
import { createLogger } from '../../logging/logger.js';
import type { Result } from '../../utils/result.js';
import { err, ok } from '../../utils/result.js';

const log = createLogger('GitHubPlugin');

import type {
  EventSourcePlugin,
  EventTypeDefinition,
  NormalizedEvent,
  SubscriptionFilter,
  TemplateVariable,
} from '../plugin-interface.js';

// ---------------------------------------------------------------------------
// GitHub webhook payload shapes (minimal, for parsing)
// ---------------------------------------------------------------------------

interface GitHubIssuePayload {
  action?: string;
  issue?: {
    title?: string;
    body?: string;
    html_url?: string;
    number?: number;
    labels?: Array<{ name: string }>;
    user?: { login: string };
  };
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  sender?: { login?: string };
}

interface GitHubPullRequestPayload {
  action?: string;
  pull_request?: {
    title?: string;
    body?: string;
    html_url?: string;
    number?: number;
    head?: { ref?: string };
    base?: { ref?: string };
    labels?: Array<{ name: string }>;
    user?: { login: string };
    merged?: boolean;
  };
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  sender?: { login?: string };
}

interface GitHubPushPayload {
  ref?: string;
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  sender?: { login?: string };
  head_commit?: {
    message?: string;
    url?: string;
  };
  commits?: Array<{ message?: string }>;
}

interface GitHubPingPayload {
  zen?: string;
  hook_id?: number;
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  sender?: { login?: string };
}

type GitHubPayload =
  | GitHubIssuePayload
  | GitHubPullRequestPayload
  | GitHubPushPayload
  | GitHubPingPayload;

// ---------------------------------------------------------------------------
// Event type definitions
// ---------------------------------------------------------------------------

const GITHUB_EVENT_TYPES: EventTypeDefinition[] = [
  {
    type: 'issues',
    label: 'Issues',
    actions: ['opened', 'closed', 'labeled', 'assigned'],
  },
  {
    type: 'pull_request',
    label: 'Pull Request',
    actions: ['opened', 'closed', 'merged', 'review_requested'],
  },
  {
    type: 'push',
    label: 'Push',
    actions: [],
  },
  {
    type: 'ping',
    label: 'Ping',
    actions: [],
  },
];

// ---------------------------------------------------------------------------
// Template variable definitions per event type
// ---------------------------------------------------------------------------

const COMMON_VARIABLES: TemplateVariable[] = [
  { name: 'event.type', description: 'Event type', example: 'issues' },
  { name: 'event.action', description: 'Event action', example: 'opened' },
  { name: 'repo.name', description: 'Repository name', example: 'my-repo' },
  { name: 'repo.full_name', description: 'Full repository name', example: 'owner/my-repo' },
  { name: 'author.login', description: 'Actor username', example: 'octocat' },
  { name: 'delivery_id', description: 'Unique delivery identifier', example: 'abc-123' },
];

const ISSUE_VARIABLES: TemplateVariable[] = [
  ...COMMON_VARIABLES,
  { name: 'issue.title', description: 'Issue title', example: 'Bug: login fails' },
  { name: 'issue.body', description: 'Issue body text', example: 'Steps to reproduce...' },
  { name: 'issue.number', description: 'Issue number', example: '42' },
  {
    name: 'issue.url',
    description: 'Issue HTML URL',
    example: 'https://github.com/owner/repo/issues/42',
  },
  { name: 'issue.labels', description: 'Comma-separated labels', example: 'bug, priority:high' },
];

const PR_VARIABLES: TemplateVariable[] = [
  ...COMMON_VARIABLES,
  { name: 'pr.title', description: 'Pull request title', example: 'Fix login bug' },
  { name: 'pr.body', description: 'Pull request body', example: 'This PR fixes...' },
  { name: 'pr.number', description: 'Pull request number', example: '99' },
  {
    name: 'pr.url',
    description: 'Pull request HTML URL',
    example: 'https://github.com/owner/repo/pull/99',
  },
  { name: 'pr.branch', description: 'Head branch name', example: 'fix/login-bug' },
  { name: 'pr.base_branch', description: 'Base branch name', example: 'main' },
];

const TEMPLATE_VARIABLES_BY_TYPE: Record<string, TemplateVariable[]> = {
  issues: ISSUE_VARIABLES,
  pull_request: PR_VARIABLES,
  push: COMMON_VARIABLES,
  ping: COMMON_VARIABLES,
};

// ---------------------------------------------------------------------------
// GitHub EventSourcePlugin implementation
// ---------------------------------------------------------------------------

export class GitHubEventSourcePlugin implements EventSourcePlugin {
  readonly type = 'github';

  /**
   * Verify webhook signature by delegating to the existing utility.
   */
  async verifySignature(
    payload: string,
    signature: string | null,
    secret: string
  ): Promise<Result<boolean, AppError>> {
    const result = await verifyWebhookSignature({ payload, signature, secret });

    if (!result.ok) {
      return err(EventErrors.SIGNATURE_INVALID);
    }

    return ok(true);
  }

  /**
   * Parse a raw GitHub webhook into a NormalizedEvent.
   */
  parseEvent(headers: Headers, rawBody: string): Result<NormalizedEvent, AppError> {
    const eventType = headers.get('x-github-event');
    const deliveryId = headers.get('x-github-delivery');

    if (!eventType || !deliveryId) {
      return err(
        EventErrors.PARSE_FAILED(
          'Missing required GitHub webhook headers (x-github-event, x-github-delivery)'
        )
      );
    }

    let payload: GitHubPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubPayload;
    } catch {
      return err(EventErrors.PARSE_FAILED('Invalid JSON body'));
    }

    const normalized = this.buildNormalizedEvent(eventType, deliveryId, payload);
    return ok(normalized);
  }

  /**
   * Return all supported GitHub event types.
   */
  getEventTypes(): EventTypeDefinition[] {
    return GITHUB_EVENT_TYPES;
  }

  /**
   * Return template variables for the given event type.
   * Falls back to common variables for unknown types.
   */
  getTemplateVariables(eventType: string): TemplateVariable[] {
    return TEMPLATE_VARIABLES_BY_TYPE[eventType] ?? COMMON_VARIABLES;
  }

  /**
   * Check whether a NormalizedEvent satisfies a single SubscriptionFilter.
   */
  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean {
    const fieldValue = this.resolveFilterField(event, filter.field);

    switch (filter.operator) {
      case 'equals':
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => v === filter.value);
        }
        return fieldValue === filter.value;

      case 'not_equals':
        if (Array.isArray(fieldValue)) {
          return !fieldValue.some((v) => v === filter.value);
        }
        return fieldValue !== filter.value;

      case 'contains':
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => v.includes(filter.value));
        }
        return typeof fieldValue === 'string' && fieldValue.includes(filter.value);

      case 'matches': {
        // Guard against ReDoS: limit regex pattern length
        if (filter.value.length > 200) {
          log.warn('Regex filter pattern exceeds maximum length', {
            data: { field: filter.field, patternLength: filter.value.length, maxLength: 200 },
          });
          return false;
        }
        try {
          const regex = new RegExp(filter.value);
          if (Array.isArray(fieldValue)) {
            return fieldValue.some((v) => regex.test(v));
          }
          return typeof fieldValue === 'string' && regex.test(fieldValue);
        } catch (regexErr) {
          log.warn('Invalid regex in subscription filter', {
            data: { field: filter.field, pattern: filter.value },
            error: regexErr instanceof Error ? regexErr.message : String(regexErr),
          });
          return false;
        }
      }

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildNormalizedEvent(
    eventType: string,
    deliveryId: string,
    payload: GitHubPayload
  ): NormalizedEvent {
    const raw = payload as unknown as Record<string, unknown>;

    switch (eventType) {
      case 'issues':
        return this.normalizeIssueEvent(eventType, deliveryId, payload as GitHubIssuePayload, raw);
      case 'pull_request':
        return this.normalizePullRequestEvent(
          eventType,
          deliveryId,
          payload as GitHubPullRequestPayload,
          raw
        );
      case 'push':
        return this.normalizePushEvent(eventType, deliveryId, payload as GitHubPushPayload, raw);
      default:
        return this.normalizeGenericEvent(eventType, deliveryId, payload, raw);
    }
  }

  private normalizeIssueEvent(
    type: string,
    deliveryId: string,
    payload: GitHubIssuePayload,
    raw: Record<string, unknown>
  ): NormalizedEvent {
    const issue = payload.issue;
    return {
      type,
      action: payload.action ?? null,
      deliveryId,
      source: {
        repo: payload.repository?.full_name,
        labels: issue?.labels?.map((l) => l.name),
        author: payload.sender?.login ?? issue?.user?.login,
      },
      data: {
        title: issue?.title,
        body: issue?.body,
        url: issue?.html_url,
        number: issue?.number,
      },
      raw,
    };
  }

  private normalizePullRequestEvent(
    type: string,
    deliveryId: string,
    payload: GitHubPullRequestPayload,
    raw: Record<string, unknown>
  ): NormalizedEvent {
    const pr = payload.pull_request;
    // GitHub sends action='closed' with merged=true for merged PRs.
    // Normalize this to action='merged' for simpler downstream matching.
    let action = payload.action ?? null;
    if (action === 'closed' && pr?.merged) {
      action = 'merged';
    }

    return {
      type,
      action,
      deliveryId,
      source: {
        repo: payload.repository?.full_name,
        branch: pr?.head?.ref,
        labels: pr?.labels?.map((l) => l.name),
        author: payload.sender?.login ?? pr?.user?.login,
      },
      data: {
        title: pr?.title,
        body: pr?.body,
        url: pr?.html_url,
        number: pr?.number,
        base_branch: pr?.base?.ref,
      },
      raw,
    };
  }

  private normalizePushEvent(
    type: string,
    deliveryId: string,
    payload: GitHubPushPayload,
    raw: Record<string, unknown>
  ): NormalizedEvent {
    // Extract branch name from refs/heads/branch-name
    const ref = payload.ref ?? '';
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;

    return {
      type,
      action: null,
      deliveryId,
      source: {
        repo: payload.repository?.full_name,
        branch,
        author: payload.sender?.login,
      },
      data: {
        title: payload.head_commit?.message,
        url: payload.head_commit?.url,
      },
      raw,
    };
  }

  private normalizeGenericEvent(
    type: string,
    deliveryId: string,
    payload: GitHubPayload,
    raw: Record<string, unknown>
  ): NormalizedEvent {
    const repo = (payload as { repository?: { full_name?: string } }).repository;
    const sender = (payload as { sender?: { login?: string } }).sender;
    const action = (payload as { action?: string }).action ?? null;

    return {
      type,
      action,
      deliveryId,
      source: {
        repo: repo?.full_name,
        author: sender?.login,
      },
      data: {},
      raw,
    };
  }

  private resolveFilterField(
    event: NormalizedEvent,
    field: SubscriptionFilter['field']
  ): string | string[] | undefined {
    switch (field) {
      case 'repo':
        return event.source.repo;
      case 'branch':
        return event.source.branch;
      case 'labels':
        return event.source.labels;
      case 'author':
        return event.source.author;
      case 'action':
        return event.action ?? undefined;
      default:
        return undefined;
    }
  }
}
