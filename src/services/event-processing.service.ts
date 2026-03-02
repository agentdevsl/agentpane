import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { EventLogStatus } from '../db/schema/index.js';
import { eventLog } from '../db/schema/index.js';
import type { AppError } from '../lib/errors/base.js';
import { EventErrors } from '../lib/errors/event-errors.js';
import type { NormalizedEvent } from '../lib/events/plugin-interface.js';
import type { PluginRegistry } from '../lib/events/plugin-registry.js';
import { buildTemplateContext, interpolateTemplate } from '../lib/events/template-engine.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { EventSourceService } from './event-source.service.js';
import type { EventSubscriptionService } from './event-subscription.service.js';
import type { TaskService } from './task.service.js';

const log = createLogger('EventProcessingService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessingResult = {
  eventLogId: string;
  status: 'processed' | 'duplicate' | 'ignored';
  matchCount: number;
  tasksCreated: string[];
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EventProcessingService {
  constructor(
    private db: Database,
    private pluginRegistry: PluginRegistry,
    private eventSourceService: EventSourceService,
    private subscriptionService: EventSubscriptionService,
    private taskService: TaskService
  ) {}

  /**
   * Process an incoming webhook event through the full pipeline:
   *
   * 1. Look up event source by slug
   * 2. Verify source is enabled
   * 3. Get plugin for source type
   * 4. Verify webhook signature
   * 5. Parse event into NormalizedEvent
   * 6. Deduplicate by deliveryId
   * 7. Log event
   * 8. Match subscriptions and create tasks
   * 9. Update event log with outcomes
   */
  async processIncomingEvent(
    sourceSlug: string,
    headers: Headers,
    rawBody: string
  ): Promise<Result<ProcessingResult, AppError>> {
    // Look up event source and verify it is enabled
    const sourceResult = await this.eventSourceService.getBySlug(sourceSlug);
    if (!sourceResult.ok) {
      log.warn('Event source not found for slug', { data: { slug: sourceSlug } });
      return sourceResult;
    }
    const source = sourceResult.value;
    log.info('Processing incoming event', {
      data: { sourceId: source.id, sourceSlug, sourceType: source.type },
    });

    if (source.status === 'disabled') {
      log.info('Ignoring event for disabled source', { data: { sourceId: source.id } });
      return err(EventErrors.SOURCE_DISABLED(source.id));
    }

    // Resolve plugin for source type
    const plugin = this.pluginRegistry.get(source.type);
    if (!plugin) {
      return err(EventErrors.PLUGIN_NOT_FOUND(source.type));
    }

    // Verify webhook signature if secret is configured
    if (source.webhookSecret) {
      let plaintextSecret: string | null;
      try {
        plaintextSecret = this.eventSourceService.decryptSecret(source);
      } catch (decryptError) {
        log.error('Failed to decrypt webhook secret', {
          data: { sourceId: source.id },
          error: decryptError,
        });
        return err(EventErrors.SECRET_DECRYPT_FAILED);
      }
      if (!plaintextSecret) {
        return err(EventErrors.SECRET_DECRYPT_FAILED);
      }

      const signatureHeader = getSignatureHeader(headers);
      const verifyResult = await plugin.verifySignature(rawBody, signatureHeader, plaintextSecret);

      if (!verifyResult.ok || !verifyResult.value) {
        log.warn('Webhook signature verification failed', { data: { sourceId: source.id } });
        return err(EventErrors.SIGNATURE_INVALID);
      }
    }

    // Parse event into NormalizedEvent
    const parseResult = plugin.parseEvent(headers, rawBody);
    if (!parseResult.ok) {
      log.warn('Failed to parse webhook event', {
        data: { sourceId: source.id },
        error: parseResult.error.message,
      });
      return parseResult;
    }
    const event: NormalizedEvent = parseResult.value;
    log.info('Parsed event', {
      data: {
        sourceId: source.id,
        type: event.type,
        action: event.action,
        deliveryId: event.deliveryId,
      },
    });

    // Deduplicate via unique constraint on (eventSourceId, deliveryId)
    const eventLogId = createId();
    const now = new Date().toISOString();

    try {
      await this.db.insert(eventLog).values({
        id: eventLogId,
        eventSourceId: source.id,
        eventType: event.type,
        action: event.action,
        status: 'received',
        payload: event.raw,
        matchedSubscriptions: [],
        deliveryId: event.deliveryId,
        receivedAt: now,
      });
    } catch (error: unknown) {
      // Check for unique constraint violation (SQLite UNIQUE constraint failed)
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('UNIQUE constraint failed') ||
        message.includes('unique constraint') ||
        message.includes('SQLITE_CONSTRAINT')
      ) {
        log.info('Duplicate event delivery skipped', {
          data: { sourceId: source.id, deliveryId: event.deliveryId },
        });
        return ok({
          eventLogId: '',
          status: 'duplicate',
          matchCount: 0,
          tasksCreated: [],
        });
      }
      log.error('Failed to insert event log', { data: { sourceId: source.id }, error: message });
      return err(EventErrors.PROCESSING_FAILED(message));
    }

    // Find matching subscriptions
    const subsResult = await this.subscriptionService.findMatchingSubscriptions(
      source.id,
      event.type
    );
    if (!subsResult.ok) {
      return subsResult;
    }
    const matchingSubscriptions = subsResult.value;

    // Evaluate filters and create tasks for each matching subscription
    const tasksCreated: string[] = [];
    const matchedSubRecords: Array<{ subscriptionId: string; taskId?: string }> = [];

    for (const subscription of matchingSubscriptions) {
      // Evaluate all filters — all must pass
      const filters = subscription.filters ?? [];

      const allFiltersMatch = filters.every((filter) => plugin.matchesFilter(event, filter));

      if (!allFiltersMatch) {
        continue;
      }

      // Build template context and interpolate prompt
      const templateContext = buildTemplateContext(event);
      const renderedPrompt = interpolateTemplate(subscription.promptTemplate, templateContext);

      // Build task title from event data
      const taskTitle = buildTaskTitle(event, subscription.name);

      // Create task via TaskService
      const taskResult = await this.taskService.create({
        projectId: subscription.targetProjectId,
        title: taskTitle,
        description: renderedPrompt,
        labels: subscription.taskLabels ?? [],
        priority: subscription.taskPriority ?? 'medium',
      });

      if (taskResult.ok) {
        const task = taskResult.value;
        tasksCreated.push(task.id);
        matchedSubRecords.push({ subscriptionId: subscription.id, taskId: task.id });
        log.info('Created task from event', {
          data: { taskId: task.id, subscriptionId: subscription.id, eventLogId },
        });

        // Move task to the configured column if not backlog (default)
        const targetColumn = subscription.taskColumn ?? 'backlog';
        if (targetColumn !== 'backlog') {
          const moveResult = await this.taskService.moveColumn(task.id, targetColumn);
          if (!moveResult.ok) {
            log.error('Failed to move task to configured column', {
              data: { taskId: task.id, targetColumn },
              error: moveResult.error.message,
            });
          }
        }

        // Note: if targetColumn is 'in_progress', the moveColumn call above
        // triggers agent auto-start via the TaskService flow automatically.
        // No separate auto-start handling is needed here.

        // Increment subscription match count
        const incrementResult = await this.subscriptionService.incrementMatchCount(subscription.id);
        if (!incrementResult.ok) {
          log.warn('Failed to increment subscription match count', {
            data: { subscriptionId: subscription.id },
            error: incrementResult.error.message,
          });
        }
      } else {
        log.error('Failed to create task from event', {
          data: { subscriptionId: subscription.id, targetProjectId: subscription.targetProjectId },
          error: taskResult.error.message,
        });
        // Record the failed subscription match without a taskId
        matchedSubRecords.push({ subscriptionId: subscription.id });
      }
    }

    // Update event log with outcomes
    const finalStatus: EventLogStatus = resolveEventStatus(tasksCreated, matchedSubRecords);

    try {
      await this.db
        .update(eventLog)
        .set({
          status: finalStatus,
          matchedSubscriptions: matchedSubRecords,
          processedAt: new Date().toISOString(),
        })
        .where(eq(eventLog.id, eventLogId));
    } catch (updateError) {
      log.error('Failed to update event log with outcomes', {
        data: { eventLogId },
        error: updateError,
      });
    }

    try {
      await this.eventSourceService.incrementEventCount(source.id);
    } catch (countError) {
      log.error('Failed to increment source event count', {
        data: { sourceId: source.id },
        error: countError,
      });
    }

    log.info('Event processing complete', {
      data: {
        eventLogId,
        status: finalStatus,
        matchCount: matchedSubRecords.length,
        tasksCreated: tasksCreated.length,
      },
    });

    return ok({
      eventLogId,
      status: tasksCreated.length > 0 || matchedSubRecords.length > 0 ? 'processed' : 'ignored',
      matchCount: matchedSubRecords.length,
      tasksCreated,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the webhook signature from common header locations.
 * GitHub uses X-Hub-Signature-256, GitLab uses X-Gitlab-Token, etc.
 */
function getSignatureHeader(headers: Headers): string | null {
  return (
    headers.get('x-hub-signature-256') ??
    headers.get('x-hub-signature') ??
    headers.get('x-gitlab-token') ??
    headers.get('x-webhook-signature') ??
    headers.get('x-signature') ??
    null
  );
}

/**
 * Determine the final event log status based on processing outcomes.
 */
function resolveEventStatus(tasksCreated: string[], matchedRecords: unknown[]): EventLogStatus {
  if (tasksCreated.length > 0) return 'task_created';
  if (matchedRecords.length > 0) return 'matched';
  return 'ignored';
}

/**
 * Build a human-readable task title from the normalized event.
 */
function buildTaskTitle(event: NormalizedEvent, subscriptionName: string): string {
  const parts: string[] = [];

  // Use event data title if available
  if (event.data.title) {
    parts.push(event.data.title);
  } else {
    // Construct from event type and action
    const action = event.action ? ` ${event.action}` : '';
    parts.push(`${event.type}${action}`);
  }

  // Add source context
  if (event.source.repo) {
    parts.push(`(${event.source.repo})`);
  }

  // Prefix with subscription name for traceability
  return `[${subscriptionName}] ${parts.join(' ')}`;
}
