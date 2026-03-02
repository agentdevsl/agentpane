# Event Plugin System - Prompt Templates

## Overview

When an event matches a subscription, the subscription's `promptTemplate` is rendered against the normalized event data to produce the task title and description (combined into a single prompt string). The template system uses `{{variable}}` interpolation with dot-notation traversal, providing a simple yet flexible way to translate external events into agent-ready task prompts.

---

## Template Syntax

### Basic Interpolation

Variables are enclosed in double curly braces: `{{variable_name}}`.

```
Fix the issue: {{issue.title}}

Repository: {{repo.full_name}}
Issue: {{issue.url}}

{{issue.body}}
```

### Dot-Notation Traversal

Variables support dot-notation to access nested properties of the `NormalizedEvent` and its `raw` payload.

```
{{repo.name}}        -> event.source.repo
{{repo.full_name}}   -> event.source.fullName
{{issue.title}}      -> event.data.title (for issue events)
{{author.login}}     -> event.source.author
```

### Literal Text

Any text outside `{{...}}` delimiters is passed through as-is.

```
[AUTO] Bug fix for {{repo.name}}#{{issue.number}}: {{issue.title}}
```

---

## Variable Resolution

The template engine resolves variables in the following order:

1. **Built-in aliases** -- mapped from the `NormalizedEvent` structure (see tables below)
2. **Dot-notation into `event.data`** -- e.g., `{{data.custom_field}}`
3. **Dot-notation into `event.raw`** -- e.g., `{{raw.pull_request.draft}}`

If a variable is not found at any level, it is replaced with an empty string and a warning is logged.

### Resolution Algorithm

```typescript
function resolveVariable(
  name: string,
  event: NormalizedEvent,
  aliases: Record<string, (event: NormalizedEvent) => string>,
): string {
  // 1. Check built-in aliases
  if (aliases[name]) {
    return aliases[name](event);
  }

  // 2. Dot-notation traversal into event.data
  const dataValue = traverseDotPath(event.data, name.replace(/^data\./, ''));
  if (dataValue !== undefined) {
    return String(dataValue);
  }

  // 3. Dot-notation traversal into event.raw
  const rawValue = traverseDotPath(event.raw, name.replace(/^raw\./, ''));
  if (rawValue !== undefined) {
    return String(rawValue);
  }

  // 4. Not found: return empty string
  console.warn(`[TemplateEngine] Variable "{{${name}}}" not found, replacing with empty string`);
  return '';
}

function traverseDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

---

## GitHub Variables

### Common Variables (All Event Types)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `event.type` | `event.type` | GitHub event type | `issues` |
| `event.action` | `event.action` | Event action | `opened` |
| `repo.name` | `event.source.repo` | Repository short name | `agentpane` |
| `repo.full_name` | `event.source.fullName` | Full repository path | `org/agentpane` |
| `author.login` | `event.source.author` | Sender's GitHub login | `octocat` |
| `delivery_id` | `event.deliveryId` | Unique delivery ID | `a1b2c3d4-e5f6-...` |

### Issue Variables (`issues` Event Type)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `issue.title` | `event.data.title` | Issue title | `Login page crashes on Safari` |
| `issue.body` | `event.data.body` | Issue body (markdown) | `## Steps to reproduce...` |
| `issue.number` | `event.data.number` | Issue number | `42` |
| `issue.url` | `event.data.url` | Issue HTML URL | `https://github.com/org/repo/issues/42` |
| `issue.labels` | `event.source.labels` (joined) | Comma-separated labels | `bug, high-priority` |
| `issue.state` | `event.raw.issue.state` | Issue state | `open` |
| `issue.assignee` | `event.raw.issue.assignee.login` | Assignee login | `jdoe` |

### Pull Request Variables (`pull_request` Event Type)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `pr.title` | `event.data.title` | PR title | `Add user authentication` |
| `pr.body` | `event.data.body` | PR body (markdown) | `This PR implements...` |
| `pr.number` | `event.data.number` | PR number | `123` |
| `pr.url` | `event.data.url` | PR HTML URL | `https://github.com/org/repo/pull/123` |
| `pr.labels` | `event.source.labels` (joined) | Comma-separated labels | `enhancement, needs-review` |
| `pr.head_branch` | `event.source.branch` | Source branch | `feature/auth` |
| `pr.base_branch` | `event.raw.pull_request.base.ref` | Target branch | `main` |
| `pr.draft` | `event.raw.pull_request.draft` | Whether PR is a draft | `false` |
| `pr.merged` | `event.raw.pull_request.merged` | Whether PR was merged | `true` |

### Push Variables (`push` Event Type)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `branch` | `event.source.branch` | Branch pushed to | `main` |
| `commits.count` | `event.raw.commits.length` | Number of commits | `3` |
| `commits.message` | `event.data.title` (head commit) | Head commit message | `Fix typo in README` |
| `commits.url` | `event.raw.compare` | Compare URL | `https://github.com/org/repo/compare/abc...def` |

### Check/Workflow Variables (`check_run`, `check_suite`, `workflow_run`)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `check.name` | `event.raw.check_run.name` | Check name | `build` |
| `check.status` | `event.raw.check_run.status` | Check status | `completed` |
| `check.conclusion` | `event.raw.check_run.conclusion` | Check conclusion | `failure` |
| `workflow.name` | `event.raw.workflow_run.name` | Workflow name | `CI` |
| `workflow.conclusion` | `event.raw.workflow_run.conclusion` | Workflow result | `failure` |
| `workflow.url` | `event.raw.workflow_run.html_url` | Workflow run URL | `https://github.com/...` |

### Comment Variables (`issue_comment`)

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `comment.body` | `event.raw.comment.body` | Comment text | `I can reproduce this...` |
| `comment.url` | `event.raw.comment.html_url` | Comment URL | `https://github.com/...` |
| `comment.author` | `event.raw.comment.user.login` | Comment author | `contributor1` |

---

## Linear Variables

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `event.type` | `event.type` | Linear event type | `Issue` |
| `event.action` | `event.action` | Event action | `create` |
| `issue.title` | `event.data.title` | Issue title | `API timeout on /users` |
| `issue.description` | `event.data.body` | Issue description | `The API is timing out...` |
| `issue.identifier` | `event.raw.data.identifier` | Linear issue ID | `ENG-123` |
| `issue.url` | `event.data.url` | Issue URL | `https://linear.app/team/issue/ENG-123` |
| `issue.priority` | `event.raw.data.priority` | Priority level (0-4) | `1` |
| `issue.state` | `event.raw.data.state.name` | State name | `In Progress` |
| `team.name` | `event.raw.data.team.name` | Team name | `Engineering` |
| `assignee.name` | `event.raw.data.assignee.name` | Assignee name | `Jane Doe` |

---

## Jira Variables

| Variable | Source | Description | Example |
|----------|--------|-------------|---------|
| `event.type` | `event.type` | Jira event type | `jira:issue_created` |
| `issue.key` | `event.raw.issue.key` | Jira issue key | `PROJ-456` |
| `issue.summary` | `event.data.title` | Issue summary | `Database migration fails` |
| `issue.description` | `event.data.body` | Issue description | `When running migrate...` |
| `issue.type` | `event.raw.issue.fields.issuetype.name` | Issue type | `Bug` |
| `issue.priority` | `event.raw.issue.fields.priority.name` | Priority name | `High` |
| `issue.status` | `event.raw.issue.fields.status.name` | Status name | `To Do` |
| `issue.url` | `event.data.url` | Issue URL | `https://jira.example.com/browse/PROJ-456` |
| `project.key` | `event.raw.issue.fields.project.key` | Project key | `PROJ` |
| `project.name` | `event.raw.issue.fields.project.name` | Project name | `My Project` |
| `user.displayName` | `event.raw.user.displayName` | Acting user | `John Smith` |

---

## Template Engine Implementation

### Rendering

```typescript
// src/lib/events/template-engine.ts

const VARIABLE_REGEX = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

export interface TemplateRenderResult {
  rendered: string;
  missingVariables: string[];
}

export function renderTemplate(
  template: string,
  event: NormalizedEvent,
  pluginType: EventSourceType,
): TemplateRenderResult {
  const aliases = getAliases(pluginType);
  const missingVariables: string[] = [];

  const rendered = template.replace(VARIABLE_REGEX, (_match, variableName: string) => {
    const value = resolveVariable(variableName, event, aliases);
    if (value === '') {
      missingVariables.push(variableName);
    }
    return sanitizeValue(value);
  });

  return { rendered, missingVariables };
}
```

### Missing Variable Handling

When a `{{variable}}` reference cannot be resolved:

1. The variable is replaced with an **empty string** in the output.
2. The variable name is added to the `missingVariables` array in the render result.
3. A **warning** is logged: `[TemplateEngine] Variable "{{variable_name}}" not found`.
4. The event log entry's `error` field is updated with a note about missing variables (if any).

This approach ensures that template rendering never fails -- it always produces output, even if incomplete.

---

## Output Sanitization

Since webhook payloads come from external systems, all interpolated values must be sanitized to prevent injection.

### Sanitization Rules

```typescript
function sanitizeValue(value: string): string {
  // 1. Trim to maximum length (prevent payload-stuffing)
  const MAX_VARIABLE_LENGTH = 10000;
  let sanitized = value.slice(0, MAX_VARIABLE_LENGTH);

  // 2. Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // 3. Normalize line endings
  sanitized = sanitized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return sanitized;
}
```

### What Is NOT Sanitized

- HTML entities are **not** escaped, because the output is used as a task prompt (plain text), not rendered as HTML.
- Markdown is **preserved**, since task descriptions support markdown.
- Unicode is **preserved** as-is.

### Array Values

When a variable resolves to an array (e.g., `issue.labels` resolving to `["bug", "urgent"]`), the array elements are joined with `, ` (comma-space).

```typescript
if (Array.isArray(value)) {
  return value.map(String).join(', ');
}
```

---

## Example Templates

### GitHub Issue to Bug Fix Task

```
Investigate and fix the reported issue in {{repo.name}}.

**Issue:** {{issue.title}} (#{{issue.number}})
**Labels:** {{issue.labels}}
**Reporter:** {{author.login}}
**URL:** {{issue.url}}

## Issue Description

{{issue.body}}

## Instructions

1. Read the issue description carefully
2. Reproduce the bug if possible
3. Identify the root cause
4. Implement a fix
5. Add tests for the fix
6. Create a pull request
```

### GitHub CI Failure to Remediation Task

```
CI check "{{check.name}}" failed on branch {{branch}} in {{repo.full_name}}.

**Conclusion:** {{check.conclusion}}
**Workflow:** {{workflow.name}}
**URL:** {{workflow.url}}

## Instructions

1. Check the CI failure logs at the URL above
2. Identify the failing test or build step
3. Fix the underlying issue
4. Verify the fix passes locally
5. Push the fix to the branch
```

### Linear Issue to Task

```
Work on Linear issue {{issue.identifier}}: {{issue.title}}

**Priority:** {{issue.priority}}
**State:** {{issue.state}}
**Team:** {{team.name}}
**URL:** {{issue.url}}

## Description

{{issue.description}}
```

### Generic Webhook

```
Process incoming webhook event.

**Event:** {{event.type}} / {{event.action}}
**Title:** {{data.title}}

{{data.body}}
```

---

## Template Editor Support

The `getTemplateVariables()` method on each plugin returns `TemplateVariable[]` to power the subscription UI's template editor:

```typescript
interface TemplateVariable {
  name: string;        // e.g., "issue.title"
  description: string; // e.g., "The title of the GitHub issue"
  example: string;     // e.g., "Fix login bug"
}
```

This data is used to:
- Provide autocomplete suggestions as the user types `{{`
- Show a variable reference panel alongside the editor
- Generate a live preview using the example values

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Plugin Interface](./plugin-interface.md) | `getTemplateVariables()` provides variables per event type |
| [Database Schema](./database-schema.md) | `promptTemplate` column on `event_subscriptions` |
| [API Endpoints](./api-endpoints.md) | Template validated on subscription create/update |
| [Task Service](../application/services/task-service.md) | Rendered template becomes task title + description |
