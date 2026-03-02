import { createError } from './base.js';

export const EventErrors = {
  // Event Source errors
  SOURCE_NOT_FOUND: (id?: string) =>
    createError(
      'EVENT_SOURCE_NOT_FOUND',
      id ? `Event source "${id}" not found` : 'Event source not found',
      404,
      id ? { id } : undefined
    ),
  SOURCE_DISABLED: (id?: string) =>
    createError(
      'EVENT_SOURCE_DISABLED',
      id ? `Event source "${id}" is disabled` : 'Event source is disabled',
      400,
      id ? { id } : undefined
    ),
  SLUG_CONFLICT: (slug: string) =>
    createError('EVENT_SLUG_CONFLICT', `Slug "${slug}" is already in use`, 409, { slug }),
  TEAM_NOT_FOUND: createError('EVENT_TEAM_NOT_FOUND', 'Team not found', 404),

  // Event Subscription errors
  SUBSCRIPTION_NOT_FOUND: (id?: string) =>
    createError(
      'EVENT_SUBSCRIPTION_NOT_FOUND',
      id ? `Subscription "${id}" not found` : 'Event subscription not found',
      404,
      id ? { id } : undefined
    ),
  PROJECT_TEAM_MISMATCH: createError(
    'EVENT_PROJECT_TEAM_MISMATCH',
    'Target project must belong to the same team as the event source',
    400
  ),

  // Webhook / processing errors
  SIGNATURE_INVALID: createError(
    'EVENT_SIGNATURE_INVALID',
    'Webhook signature verification failed',
    401
  ),
  PARSE_FAILED: (reason: string) =>
    createError('EVENT_PARSE_FAILED', `Failed to parse webhook event: ${reason}`, 400, {
      reason,
    }),
  PLUGIN_NOT_FOUND: (type: string) =>
    createError('EVENT_PLUGIN_NOT_FOUND', `No plugin registered for source type: ${type}`, 400, {
      type,
    }),
  PROCESSING_FAILED: (reason: string) =>
    createError('EVENT_PROCESSING_FAILED', `Event processing failed: ${reason}`, 500, {
      reason,
    }),
  SECRET_DECRYPT_FAILED: createError(
    'EVENT_SECRET_DECRYPT_FAILED',
    'Failed to decrypt webhook secret',
    500
  ),
} as const;

export type EventError =
  | ReturnType<typeof EventErrors.SOURCE_NOT_FOUND>
  | ReturnType<typeof EventErrors.SOURCE_DISABLED>
  | ReturnType<typeof EventErrors.SLUG_CONFLICT>
  | typeof EventErrors.TEAM_NOT_FOUND
  | ReturnType<typeof EventErrors.SUBSCRIPTION_NOT_FOUND>
  | typeof EventErrors.PROJECT_TEAM_MISMATCH
  | typeof EventErrors.SIGNATURE_INVALID
  | ReturnType<typeof EventErrors.PARSE_FAILED>
  | ReturnType<typeof EventErrors.PLUGIN_NOT_FOUND>
  | ReturnType<typeof EventErrors.PROCESSING_FAILED>
  | typeof EventErrors.SECRET_DECRYPT_FAILED;

// ---------------------------------------------------------------------------
// Schedule Errors (used by SchedulerService)
// ---------------------------------------------------------------------------

export const ScheduleErrors = {
  INVALID_CRON: (expression: string) =>
    createError('SCHEDULE_INVALID_CRON', `Invalid cron expression: "${expression}"`, 400, {
      expression,
    }),
  INVALID_INTERVAL: (interval: number) =>
    createError(
      'SCHEDULE_INVALID_INTERVAL',
      `Interval must be >= 60 seconds, got ${interval}`,
      400,
      {
        interval,
      }
    ),
  INVALID_TIMEZONE: (timezone: string) =>
    createError('SCHEDULE_INVALID_TIMEZONE', `Invalid IANA timezone: "${timezone}"`, 400, {
      timezone,
    }),
  BUDGET_EXCEEDED: (sourceId: string, window: string) =>
    createError('SCHEDULE_BUDGET_EXCEEDED', `Execution budget exceeded for ${window} window`, 429, {
      sourceId,
      window,
    }),
  SOURCE_PAUSED: (sourceId: string) =>
    createError('SCHEDULE_SOURCE_PAUSED', `Schedule "${sourceId}" is paused`, 422, { sourceId }),
  EXECUTION_FAILED: (sourceId: string, reason: string) =>
    createError('SCHEDULE_EXECUTION_FAILED', `Scheduled execution failed: ${reason}`, 500, {
      sourceId,
      reason,
    }),
  NOT_CRON_TYPE: (sourceId: string) =>
    createError('SCHEDULE_NOT_CRON_TYPE', `Event source "${sourceId}" is not a cron type`, 400, {
      sourceId,
    }),
  ALREADY_PAUSED: (sourceId: string) =>
    createError('SCHEDULE_ALREADY_PAUSED', `Schedule "${sourceId}" is already paused`, 409, {
      sourceId,
    }),
  ALREADY_ACTIVE: (sourceId: string) =>
    createError('SCHEDULE_ALREADY_ACTIVE', `Schedule "${sourceId}" is already active`, 409, {
      sourceId,
    }),
} as const;
