# Event Plugin System - Plugin Interface

## Overview

Each external event source type (GitHub, Linear, Jira, generic webhook) is implemented as a plugin that conforms to the `EventSourcePlugin` interface. Plugins are responsible for verifying webhook signatures, parsing raw payloads into a normalized event format, declaring supported event types, and evaluating subscription filters.

Plugins are stateless singletons registered in a plugin registry keyed by `EventSourceType`.

---

## Plugin Registry

```typescript
// src/services/event-plugins/plugin-registry.ts
import type { EventSourceType } from '@/db/schema/shared/enums';
import type { EventSourcePlugin } from './types';
import { GitHubPlugin } from './github-plugin';
import { LinearPlugin } from './linear-plugin';
import { JiraPlugin } from './jira-plugin';
import { GenericWebhookPlugin } from './generic-webhook-plugin';

const registry: Record<EventSourceType, EventSourcePlugin> = {
  github: new GitHubPlugin(),
  linear: new LinearPlugin(),
  jira: new JiraPlugin(),
  generic_webhook: new GenericWebhookPlugin(),
};

export function getPlugin(type: EventSourceType): EventSourcePlugin {
  return registry[type];
}
```

---

## EventSourcePlugin Interface

```typescript
// src/services/event-plugins/types.ts
import type { Result } from '@/lib/utils/result';
import type { AppError } from '@/lib/errors';

export interface EventSourcePlugin {
  /**
   * Verify that the incoming webhook payload was sent by the expected
   * source using HMAC signature comparison.
   *
   * @param payload   - Raw request body as a Buffer or string
   * @param signature - Signature header value from the request
   * @param secret    - The HMAC secret stored for this event source
   * @returns Result<boolean> - true if valid, false if invalid signature
   */
  verifySignature(
    payload: Buffer | string,
    signature: string,
    secret: string,
  ): Result<boolean, AppError>;

  /**
   * Parse the raw webhook request into a NormalizedEvent.
   *
   * @param headers - HTTP request headers (lowercase keys)
   * @param rawBody - Raw request body (string or parsed JSON)
   * @returns Result<NormalizedEvent> with all fields populated
   */
  parseEvent(
    headers: Record<string, string>,
    rawBody: string | Record<string, unknown>,
  ): Result<NormalizedEvent, AppError>;

  /**
   * Return all event types this plugin can produce.
   * Used to populate the subscription creation UI.
   */
  getEventTypes(): EventTypeDefinition[];

  /**
   * Return the template variables available for a specific event type.
   * Used to populate the prompt template editor with autocomplete suggestions.
   *
   * @param eventType - The event type to get variables for (e.g., "issues")
   */
  getTemplateVariables(eventType: string): TemplateVariable[];

  /**
   * Evaluate whether a normalized event matches a subscription filter.
   * The plugin knows how to extract the relevant fields from the event
   * and compare them against the filter conditions.
   *
   * @param event  - The normalized event to evaluate
   * @param filter - A single SubscriptionFilter (all fields AND-combined)
   * @returns true if the event matches all specified filter fields
   */
  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean;
}
```

---

## NormalizedEvent

The common event format that all plugins produce. This is the data structure available to template interpolation and filter matching.

```typescript
export interface NormalizedEvent {
  /** Event type (e.g., "issues", "pull_request", "push", "issue") */
  type: string;

  /** Event action (e.g., "opened", "closed", "merged", "created") */
  action: string;

  /**
   * External delivery identifier for deduplication.
   * Sourced from provider-specific headers.
   */
  deliveryId: string;

  /** Source context */
  source: {
    /** Repository or project name (e.g., "agentpane") */
    repo: string;
    /** Full repository path (e.g., "org/agentpane") */
    fullName: string;
    /** Branch name, if applicable */
    branch?: string;
    /** Labels on the event entity (issue, PR, etc.) */
    labels: string[];
    /** Author login */
    author: string;
  };

  /** Event entity data */
  data: {
    /** Title of the issue, PR, ticket, etc. */
    title: string;
    /** Body or description text */
    body: string;
    /** URL to the entity in the external system */
    url: string;
    /** Numeric identifier (issue number, PR number, etc.) */
    number?: number;
    /** Additional data varies by event type */
    [key: string]: unknown;
  };

  /** Original raw payload from the external system (for audit/debug) */
  raw: Record<string, unknown>;
}
```

---

## Supporting Types

```typescript
/**
 * Describes an event type that a plugin can produce.
 */
export interface EventTypeDefinition {
  /** Machine-readable event type (e.g., "issues", "pull_request") */
  type: string;
  /** Human-readable label (e.g., "Issues", "Pull Requests") */
  label: string;
  /** Brief description for the UI */
  description: string;
  /** Possible actions for this event type */
  actions: string[];
}

/**
 * Describes a template variable available for prompt interpolation.
 */
export interface TemplateVariable {
  /** Variable name using dot-notation (e.g., "issue.title", "repo.name") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Example value for the template editor preview */
  example: string;
}

/**
 * A single filter condition (imported from database-schema.md).
 * All specified fields must match (AND logic).
 */
export interface SubscriptionFilter {
  repository?: string;
  branch?: string;
  labels?: string[];
  action?: string;
  author?: string;
}
```

---

## GitHub Plugin

The GitHub plugin is the primary implementation and serves as the reference for other plugins.

### Supported Event Types

| Event Type | Actions | Description |
|------------|---------|-------------|
| `issues` | `opened`, `edited`, `closed`, `reopened`, `labeled`, `unlabeled`, `assigned`, `unassigned` | GitHub issue events |
| `pull_request` | `opened`, `edited`, `closed`, `reopened`, `merged`, `ready_for_review`, `review_requested`, `labeled`, `unlabeled` | Pull request events |
| `push` | (none -- action is empty) | Push to a branch |
| `issue_comment` | `created`, `edited`, `deleted` | Comment on an issue or PR |
| `pull_request_review` | `submitted`, `edited`, `dismissed` | PR review events |
| `check_run` | `created`, `completed`, `rerequested` | CI check run events |
| `check_suite` | `completed`, `rerequested` | CI check suite events |
| `workflow_run` | `requested`, `in_progress`, `completed` | GitHub Actions workflow |
| `release` | `published`, `created`, `edited`, `deleted` | Release events |

### Signature Verification

```typescript
// GitHub uses HMAC-SHA256 with the X-Hub-Signature-256 header
// Format: "sha256=<hex-digest>"

import { createHmac, timingSafeEqual } from 'node:crypto';

class GitHubPlugin implements EventSourcePlugin {
  verifySignature(
    payload: Buffer | string,
    signature: string,
    secret: string,
  ): Result<boolean, AppError> {
    if (!signature.startsWith('sha256=')) {
      return { ok: false, error: new AppError('EVENT_INVALID_SIGNATURE', 'Missing sha256= prefix') };
    }

    const expected = 'sha256=' + createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : payload)
      .digest('hex');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (sigBuffer.length !== expectedBuffer.length) {
      return { ok: true, data: false };
    }

    const isValid = timingSafeEqual(sigBuffer, expectedBuffer);
    return { ok: true, data: isValid };
  }
  // ...
}
```

### Event Parsing

```typescript
parseEvent(
  headers: Record<string, string>,
  rawBody: string | Record<string, unknown>,
): Result<NormalizedEvent, AppError> {
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const eventType = headers['x-github-event'];
  const deliveryId = headers['x-github-delivery'];

  if (!eventType || !deliveryId) {
    return {
      ok: false,
      error: new AppError('EVENT_PARSE_ERROR', 'Missing X-GitHub-Event or X-GitHub-Delivery header'),
    };
  }

  const repo = body.repository;
  const sender = body.sender;

  // Extract entity based on event type
  const entity = body.issue || body.pull_request || body.release || {};
  const labels = (entity.labels || []).map((l: { name: string }) => l.name);

  // Determine branch
  let branch: string | undefined;
  if (eventType === 'push') {
    // refs/heads/main -> main
    branch = (body.ref as string)?.replace('refs/heads/', '');
  } else if (body.pull_request) {
    branch = body.pull_request.head?.ref;
  }

  const normalized: NormalizedEvent = {
    type: eventType,
    action: body.action || '',
    deliveryId,
    source: {
      repo: repo?.name || '',
      fullName: repo?.full_name || '',
      branch,
      labels,
      author: sender?.login || '',
    },
    data: {
      title: entity.title || body.head_commit?.message || '',
      body: entity.body || '',
      url: entity.html_url || repo?.html_url || '',
      number: entity.number,
    },
    raw: body as Record<string, unknown>,
  };

  return { ok: true, data: normalized };
}
```

### Template Variables

Variables available for GitHub events. See [prompt-templates.md](./prompt-templates.md) for interpolation syntax.

| Variable | Description | Example |
|----------|-------------|---------|
| `event.type` | The GitHub event type | `issues` |
| `event.action` | The event action | `opened` |
| `repo.name` | Repository short name | `agentpane` |
| `repo.full_name` | Full repository path | `org/agentpane` |
| `issue.title` | Issue title | `Fix login bug` |
| `issue.body` | Issue body text | `The login page crashes...` |
| `issue.number` | Issue number | `42` |
| `issue.url` | Issue URL | `https://github.com/org/repo/issues/42` |
| `issue.labels` | Comma-separated label names | `bug, high-priority` |
| `pr.title` | Pull request title | `Add user auth` |
| `pr.body` | Pull request body | `This PR adds...` |
| `pr.number` | PR number | `123` |
| `pr.url` | PR URL | `https://github.com/org/repo/pull/123` |
| `pr.head_branch` | PR source branch | `feature/auth` |
| `pr.base_branch` | PR target branch | `main` |
| `pr.labels` | Comma-separated label names | `enhancement` |
| `author.login` | Event sender's login | `octocat` |
| `delivery_id` | GitHub delivery ID | `a1b2c3d4-...` |
| `branch` | Branch name (push events) | `main` |
| `commits.count` | Number of commits (push) | `3` |
| `commits.message` | Head commit message (push) | `Fix typo in README` |

### Filter Matching

```typescript
matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean {
  // All specified fields must match (AND logic)

  if (filter.repository) {
    const repoMatch =
      event.source.repo === filter.repository ||
      event.source.fullName === filter.repository;
    if (!repoMatch) return false;
  }

  if (filter.branch) {
    if (!event.source.branch) return false;
    // Support glob patterns via minimatch-style matching
    if (!matchGlob(event.source.branch, filter.branch)) return false;
  }

  if (filter.labels && filter.labels.length > 0) {
    // Event must have at least one of the specified labels
    const hasLabel = filter.labels.some((l) => event.source.labels.includes(l));
    if (!hasLabel) return false;
  }

  if (filter.action) {
    if (event.action !== filter.action) return false;
  }

  if (filter.author) {
    if (event.source.author !== filter.author) return false;
  }

  return true;
}
```

---

## Linear Plugin (Summary)

| Aspect | Details |
|--------|---------|
| Signature Header | `Linear-Signature` |
| Signature Method | HMAC-SHA256 |
| Delivery ID Header | `Linear-Delivery` |
| Event Types | `Issue`, `Comment`, `IssueLabel`, `Cycle`, `Project` |
| Key Variables | `issue.title`, `issue.description`, `issue.identifier`, `issue.url`, `issue.priority`, `issue.state`, `team.name`, `assignee.name` |

---

## Jira Plugin (Summary)

| Aspect | Details |
|--------|---------|
| Signature Header | `X-Hub-Signature` |
| Signature Method | HMAC-SHA256 |
| Delivery ID Header | `X-Atlassian-Webhook-Identifier` |
| Event Types | `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `comment_created`, `sprint_started`, `sprint_closed` |
| Key Variables | `issue.key`, `issue.summary`, `issue.description`, `issue.type`, `issue.priority`, `issue.status`, `project.key`, `project.name`, `user.displayName` |

---

## Generic Webhook Plugin (Summary)

The generic webhook plugin handles arbitrary HTTP POST payloads. It provides a baseline implementation for sources that do not have a dedicated plugin.

| Aspect | Details |
|--------|---------|
| Signature Header | `X-Webhook-Signature` (configurable) |
| Signature Method | HMAC-SHA256 |
| Delivery ID Header | `X-Delivery-Id` (falls back to generated UUID) |
| Event Types | `webhook` (single catch-all type) |
| Actions | Extracted from `body.action` if present, otherwise empty |
| Key Variables | `event.type`, `event.action`, `payload.*` (dot-notation into raw payload) |

```typescript
parseEvent(
  headers: Record<string, string>,
  rawBody: string | Record<string, unknown>,
): Result<NormalizedEvent, AppError> {
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const deliveryId = headers['x-delivery-id'] || createId();

  const normalized: NormalizedEvent = {
    type: 'webhook',
    action: (body.action as string) || '',
    deliveryId,
    source: {
      repo: '',
      fullName: '',
      labels: [],
      author: '',
    },
    data: {
      title: (body.title as string) || (body.subject as string) || '',
      body: (body.body as string) || (body.message as string) || (body.text as string) || '',
      url: (body.url as string) || (body.link as string) || '',
    },
    raw: body as Record<string, unknown>,
  };

  return { ok: true, data: normalized };
}
```

---

## Error Codes

New error codes for the event plugin system, following the existing error catalog pattern:

| Code | HTTP | Description |
|------|------|-------------|
| `EVENT_SOURCE_NOT_FOUND` | 404 | Event source with the given slug or ID does not exist |
| `EVENT_INVALID_SIGNATURE` | 401 | Webhook signature verification failed |
| `EVENT_PARSE_ERROR` | 400 | Failed to parse the webhook payload |
| `EVENT_DUPLICATE` | 200 | Event with this deliveryId already processed (not an error, returns 200) |
| `EVENT_SOURCE_DISABLED` | 422 | Event source is disabled, not processing |
| `EVENT_SUBSCRIPTION_NOT_FOUND` | 404 | Subscription not found |
| `EVENT_TEMPLATE_ERROR` | 500 | Failed to render prompt template |
| `EVENT_TASK_CREATION_FAILED` | 500 | Failed to create task from matched event |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](./database-schema.md) | `EventSourceType` maps to plugin registry |
| [Prompt Templates](./prompt-templates.md) | `getTemplateVariables()` feeds the template system |
| [State Machine](./state-machine.md) | Pipeline stages that call plugin methods |
| [API Endpoints](./api-endpoints.md) | Webhook endpoint invokes plugin pipeline |
| [GitHub App](../application/integrations/github-app.md) | GitHub plugin shares signature verification approach |
