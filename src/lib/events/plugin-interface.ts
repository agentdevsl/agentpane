import type { AppError } from '../errors/base.js';
import type { Result } from '../utils/result.js';

/**
 * Core plugin interface for event sources (GitHub, GitLab, etc.).
 * Each plugin knows how to verify, parse, and filter events from its source.
 */
export interface EventSourcePlugin {
  /** Unique identifier for this source type (e.g., 'github') */
  readonly type: string;

  /** Verify the webhook signature against the shared secret */
  verifySignature(
    payload: string,
    signature: string | null,
    secret: string
  ): Promise<Result<boolean, AppError>>;

  /** Parse raw webhook headers + body into a NormalizedEvent */
  parseEvent(headers: Headers, rawBody: string): Result<NormalizedEvent, AppError>;

  /** Return all event type definitions this plugin supports */
  getEventTypes(): EventTypeDefinition[];

  /** Return available template variables for a given event type */
  getTemplateVariables(eventType: string): TemplateVariable[];

  /** Check whether a NormalizedEvent matches a subscription filter */
  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean;
}

/**
 * A webhook event normalized into a common shape across all source types.
 */
export interface NormalizedEvent {
  /** Event type, e.g. 'issues', 'pull_request', 'push' */
  type: string;
  /** Event action, e.g. 'opened', 'closed', or null for action-less events */
  action: string | null;
  /** Unique delivery ID from the source */
  deliveryId: string;
  /** Source metadata extracted from the event */
  source: {
    repo?: string;
    branch?: string;
    labels?: string[];
    author?: string;
  };
  /** Structured data extracted from the event payload */
  data: {
    title?: string;
    body?: string;
    url?: string;
    number?: number;
    [key: string]: unknown;
  };
  /** The full original payload for advanced use cases */
  raw: Record<string, unknown>;
}

/**
 * Describes an event type a plugin can emit, with its possible actions.
 */
export interface EventTypeDefinition {
  type: string;
  label: string;
  actions: string[];
}

/**
 * Describes a template variable available for interpolation.
 */
export interface TemplateVariable {
  name: string;
  description: string;
  example?: string;
}

/**
 * A filter criterion for matching events against subscriptions.
 */
export interface SubscriptionFilter {
  field: 'repo' | 'branch' | 'labels' | 'author' | 'action';
  operator: 'equals' | 'contains' | 'matches' | 'not_equals';
  value: string;
}
