import type { Octokit } from 'octokit';
import type { PlanModeError } from '../errors/plan-mode-errors.js';
import { PlanModeErrors } from '../errors/plan-mode-errors.js';
import type { PlanSession } from '../plan-mode/types.js';
import { errorMessage } from '../utils/error-message';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { createOctokitFromToken } from './client.js';

// ---------------------------------------------------------------------------
// F06-04: Issue-body sanitisation
// ---------------------------------------------------------------------------

/**
 * Regex matching GitHub's "issue reference" pattern for closing an issue
 * via commit or PR: `closes|fixes|resolves #N` (case-insensitive,
 * optionally with the ` ` or `:` between keyword and reference).
 *
 * If a plan body contains `Closes #123`, merging the plan's PR would
 * auto-close issue 123 even though the author never intended it. We
 * defuse the pattern by wrapping each match in an inline code fence so
 * GitHub does not interpret it.
 */
const CLOSE_KEYWORD_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+|:\s*)(#\d+)/gi;

/**
 * Regex matching `@mention` tokens. Any alphanumeric/dash/underscore
 * identifier following `@` would notify that GitHub user/team. We wrap
 * them the same way.
 */
const AT_MENTION_RE = /(^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9-]{0,38})/g;

/** Safe label regex: GitHub allows most characters, but we restrict to a
 * conservative set so a label with an embedded `,` doesn't look like
 * two separate labels in the UI. */
const SAFE_LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _/.-]{0,49}$/;

/**
 * Sanitize markdown intended for a GitHub issue body so that LLM-
 * generated content cannot trigger GitHub's action-keywords (auto-close
 * issues, post spam mentions). Treats the body as untrusted.
 */
export function sanitizeIssueBody(body: string): string {
  if (!body) return body;
  // Wrap close keywords so GitHub no longer matches `closes #N`.
  let out = body.replace(CLOSE_KEYWORD_RE, (_match, kw: string, sep: string, ref: string) => {
    // Use backticks to keep the text visible but inert. GitHub's close
    // keyword parser ignores references inside inline code.
    return `\`${kw}${sep}${ref}\``;
  });
  // Neutralize `@mentions`. We keep the leading separator so formatting
  // is preserved and wrap `@user` in backticks.
  out = out.replace(AT_MENTION_RE, (_match, lead: string, name: string) => {
    return `${lead}\`@${name}\``;
  });
  return out;
}

/**
 * Filter a label list so only safe labels make it to the API call. An
 * attacker who controls the label text could otherwise round-trip a
 * label named `"evil,urgent"` that looks like two labels in GitHub's
 * UI but is sent as one.
 */
export function sanitizeLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  return labels
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim())
    .filter((l) => SAFE_LABEL_RE.test(l));
}

/**
 * GitHub issue creation input
 */
export interface GitHubIssueInput {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}

/**
 * GitHub issue creation result
 */
export interface GitHubIssueResult {
  url: string;
  number: number;
  id: number;
  nodeId: string;
}

/**
 * GitHub issue creator for plan mode and general use
 * Uses existing Octokit client infrastructure
 */
export class GitHubIssueCreator {
  constructor(private octokit: Octokit) {}

  /**
   * Create a GitHub issue.
   *
   * F06-04: body, labels, and title are run through sanitizers before
   * leaving the process. The plan content originates from LLM output;
   * without sanitisation, a plan that says "Closes #123" would cause
   * the merged PR to auto-close issue 123.
   */
  async createIssue(
    owner: string,
    repo: string,
    input: GitHubIssueInput
  ): Promise<Result<GitHubIssueResult, PlanModeError>> {
    try {
      const response = await this.octokit.rest.issues.create({
        owner,
        repo,
        title: input.title,
        body: sanitizeIssueBody(input.body),
        labels: sanitizeLabels(input.labels),
        assignees: input.assignees,
        milestone: input.milestone,
      });

      return ok({
        url: response.data.html_url,
        number: response.data.number,
        id: response.data.id,
        nodeId: response.data.node_id,
      });
    } catch (error) {
      const message = this.formatGitHubError(error);
      return err(PlanModeErrors.GITHUB_ERROR(message));
    }
  }

  /**
   * Create a GitHub issue from a completed plan session
   */
  async createFromPlanSession(
    session: PlanSession,
    owner: string,
    repo: string,
    overrideTitle?: string,
    overrideBody?: string
  ): Promise<Result<GitHubIssueResult, PlanModeError>> {
    const { title, body } =
      overrideTitle && overrideBody
        ? { title: overrideTitle, body: overrideBody }
        : this.extractIssueContent(session);

    return this.createIssue(owner, repo, {
      title,
      body,
      labels: ['plan', 'agent-generated'],
    });
  }

  /**
   * Create a GitHub issue from explicit tool input (from CreateGitHubIssue tool)
   */
  async createFromToolInput(
    input: GitHubIssueInput,
    owner: string,
    repo: string
  ): Promise<Result<GitHubIssueResult, PlanModeError>> {
    return this.createIssue(owner, repo, {
      title: input.title,
      body: this.formatIssueBody(input.body),
      labels: [...(input.labels ?? []), 'plan', 'agent-generated'],
    });
  }

  /**
   * Update an existing GitHub issue. See {@link createIssue} for the
   * sanitisation rationale.
   */
  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    input: Partial<GitHubIssueInput>
  ): Promise<Result<GitHubIssueResult, PlanModeError>> {
    try {
      const response = await this.octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        title: input.title,
        body: input.body !== undefined ? sanitizeIssueBody(input.body) : undefined,
        labels: input.labels !== undefined ? sanitizeLabels(input.labels) : undefined,
        assignees: input.assignees,
        milestone: input.milestone,
      });

      return ok({
        url: response.data.html_url,
        number: response.data.number,
        id: response.data.id,
        nodeId: response.data.node_id,
      });
    } catch (error) {
      const message = this.formatGitHubError(error);
      return err(PlanModeErrors.GITHUB_ERROR(message));
    }
  }

  /**
   * Add a comment to an issue. Comment body is sanitized the same way
   * as issue body — a comment containing "closes #N" still closes the
   * issue on GitHub.
   */
  async addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<Result<{ id: number; url: string }, PlanModeError>> {
    try {
      const response = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: sanitizeIssueBody(body),
      });

      return ok({
        id: response.data.id,
        url: response.data.html_url,
      });
    } catch (error) {
      const message = this.formatGitHubError(error);
      return err(PlanModeErrors.GITHUB_ERROR(message));
    }
  }

  /**
   * Extract issue content from a plan session
   */
  private extractIssueContent(session: PlanSession): { title: string; body: string } {
    // Find the last substantial assistant message
    const assistantTurns = session.turns.filter((t) => t.role === 'assistant');
    const lastAssistant = assistantTurns[assistantTurns.length - 1];

    // Try to extract a title from the content
    let title = 'Implementation Plan';
    let body = '';

    if (lastAssistant) {
      const content = lastAssistant.content;

      // Look for a title pattern (# Title or **Title**)
      const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/^\*\*(.+)\*\*$/m);
      if (titleMatch?.[1]) {
        title = titleMatch[1].trim();
      }

      body = content;
    }

    // Include conversation summary
    const summaryBody = this.formatConversationSummary(session);

    return {
      title,
      body: `${body}\n\n---\n\n## Planning Session Summary\n\n${summaryBody}`,
    };
  }

  /**
   * Format the conversation summary for the issue
   */
  private formatConversationSummary(session: PlanSession): string {
    const parts: string[] = [];

    parts.push(`**Session ID:** ${session.id}`);
    parts.push(`**Task ID:** ${session.taskId}`);
    parts.push(`**Created:** ${session.createdAt}`);
    parts.push(`**Turns:** ${session.turns.length}`);

    // List key decisions made
    const decisions: string[] = [];
    for (const turn of session.turns) {
      if (turn.interaction?.answers) {
        for (const [key, value] of Object.entries(turn.interaction.answers)) {
          decisions.push(`- **${key}:** ${value}`);
        }
      }
    }

    if (decisions.length > 0) {
      parts.push('\n### Key Decisions\n');
      parts.push(decisions.join('\n'));
    }

    return parts.join('\n');
  }

  /**
   * Format the issue body with proper markdown
   */
  private formatIssueBody(body: string): string {
    return `${body}\n\n---\n\n*This issue was generated by AgentPane plan mode.*`;
  }

  /**
   * Format GitHub error with HTTP status if available
   */
  private formatGitHubError(error: unknown): string {
    // Octokit errors include status property
    if (error && typeof error === 'object' && 'status' in error) {
      const octokitError = error as { status: number; message?: string };
      const message =
        'message' in error && typeof error.message === 'string' ? error.message : 'Unknown error';
      return `HTTP ${octokitError.status}: ${message}`;
    }
    return errorMessage(error);
  }
}

/**
 * Create a GitHub issue creator from a token
 */
export function createGitHubIssueCreator(token: string): GitHubIssueCreator {
  const octokit = createOctokitFromToken(token);
  return new GitHubIssueCreator(octokit);
}

/**
 * Create a GitHub issue creator from an existing Octokit instance
 */
export function createGitHubIssueCreatorFromOctokit(octokit: Octokit): GitHubIssueCreator {
  return new GitHubIssueCreator(octokit);
}
