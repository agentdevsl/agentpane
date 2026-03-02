import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  EventSubscription,
  SubscriptionFilter,
  TaskColumn,
  TaskPriority,
} from '../db/schema/index.js';
import { eventSources, eventSubscriptions, teamProjects } from '../db/schema/index.js';
import type { AppError } from '../lib/errors/base.js';
import { EventErrors } from '../lib/errors/event-errors.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type CreateSubscriptionInput = {
  name: string;
  eventSourceId: string;
  targetProjectId: string;
  eventTypes?: string[];
  filters?: SubscriptionFilter[];
  promptTemplate: string;
  autoStartAgent?: boolean;
  taskColumn?: TaskColumn;
  taskPriority?: TaskPriority;
  taskLabels?: string[];
};

export type UpdateSubscriptionInput = {
  name?: string;
  isEnabled?: boolean;
  eventTypes?: string[];
  filters?: SubscriptionFilter[];
  promptTemplate?: string;
  autoStartAgent?: boolean;
  taskColumn?: TaskColumn;
  taskPriority?: TaskPriority;
  taskLabels?: string[];
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EventSubscriptionService {
  constructor(private db: Database) {}

  /**
   * Create a new subscription linking an event source to a project.
   * Validates that the event source exists and that the target project
   * belongs to the same team as the source.
   */
  async create(input: CreateSubscriptionInput): Promise<Result<EventSubscription, AppError>> {
    const {
      name,
      eventSourceId,
      targetProjectId,
      eventTypes = [],
      filters = [],
      promptTemplate,
      autoStartAgent = false,
      taskColumn = 'backlog',
      taskPriority = 'medium',
      taskLabels = [],
    } = input;

    // Validate event source exists
    const source = await this.db.query.eventSources.findFirst({
      where: eq(eventSources.id, eventSourceId),
    });

    if (!source) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    // Validate target project belongs to the same team as the source.
    // Join through team_projects to verify team membership.
    const teamProject = await this.db.query.teamProjects.findFirst({
      where: and(
        eq(teamProjects.teamId, source.teamId),
        eq(teamProjects.projectId, targetProjectId)
      ),
    });

    if (!teamProject) {
      return err(EventErrors.PROJECT_TEAM_MISMATCH());
    }

    const now = new Date().toISOString();

    const [subscription] = await this.db
      .insert(eventSubscriptions)
      .values({
        id: createId(),
        name,
        eventSourceId,
        targetProjectId,
        isEnabled: true,
        eventTypes,
        filters,
        promptTemplate,
        autoStartAgent,
        taskColumn,
        taskPriority,
        taskLabels,
        matchedCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!subscription) {
      return err(
        EventErrors.PROCESSING_FAILED('Failed to create subscription — insert returned no rows')
      );
    }

    return ok(subscription);
  }

  /**
   * Get a subscription by ID.
   */
  async getById(id: string): Promise<Result<EventSubscription, AppError>> {
    const subscription = await this.db.query.eventSubscriptions.findFirst({
      where: eq(eventSubscriptions.id, id),
    });

    if (!subscription) {
      return err(EventErrors.SUBSCRIPTION_NOT_FOUND());
    }

    return ok(subscription);
  }

  /**
   * List all subscriptions for a given event source.
   */
  async listBySource(eventSourceId: string): Promise<Result<EventSubscription[], AppError>> {
    const subscriptions = await this.db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, eventSourceId),
      orderBy: [desc(eventSubscriptions.createdAt)],
    });

    return ok(subscriptions);
  }

  /**
   * List all subscriptions targeting a specific project.
   */
  async listByProject(projectId: string): Promise<Result<EventSubscription[], AppError>> {
    const subscriptions = await this.db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.targetProjectId, projectId),
      orderBy: [desc(eventSubscriptions.createdAt)],
    });

    return ok(subscriptions);
  }

  /**
   * Partially update a subscription.
   */
  async update(
    id: string,
    input: UpdateSubscriptionInput
  ): Promise<Result<EventSubscription, AppError>> {
    const definedFields = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined)
    );

    const updateData: Record<string, unknown> = {
      ...definedFields,
      updatedAt: new Date().toISOString(),
    };

    const [updated] = await this.db
      .update(eventSubscriptions)
      .set(updateData)
      .where(eq(eventSubscriptions.id, id))
      .returning();

    if (!updated) {
      return err(EventErrors.SUBSCRIPTION_NOT_FOUND());
    }

    return ok(updated);
  }

  /**
   * Delete a subscription by ID.
   */
  async delete(id: string): Promise<Result<void, AppError>> {
    const [deleted] = await this.db
      .delete(eventSubscriptions)
      .where(eq(eventSubscriptions.id, id))
      .returning({ id: eventSubscriptions.id });

    if (!deleted) {
      return err(EventErrors.SUBSCRIPTION_NOT_FOUND());
    }

    return ok(undefined);
  }

  /**
   * Find enabled subscriptions for a source that match the given event type.
   *
   * A subscription matches if:
   * - It is enabled
   * - It belongs to the given event source
   * - Its eventTypes array is empty (wildcard: matches all types) OR contains the event type
   */
  async findMatchingSubscriptions(
    eventSourceId: string,
    eventType: string
  ): Promise<Result<EventSubscription[], AppError>> {
    // Fetch all enabled subscriptions for this source
    const subscriptions = await this.db.query.eventSubscriptions.findMany({
      where: and(
        eq(eventSubscriptions.eventSourceId, eventSourceId),
        eq(eventSubscriptions.isEnabled, true)
      ),
    });

    // Filter in application code: match if eventTypes is empty (wildcard) or includes the type
    const matching = subscriptions.filter((sub) => {
      const types = sub.eventTypes as string[] | null;
      if (!types || types.length === 0) {
        return true; // Wildcard: matches all event types
      }
      return types.includes(eventType);
    });

    return ok(matching);
  }

  /**
   * Increment the match count and update lastMatchedAt for a subscription.
   */
  async incrementMatchCount(id: string): Promise<Result<void, AppError>> {
    const [updated] = await this.db
      .update(eventSubscriptions)
      .set({
        matchedCount: sql`${eventSubscriptions.matchedCount} + 1`,
        lastMatchedAt: new Date().toISOString(),
      })
      .where(eq(eventSubscriptions.id, id))
      .returning();

    if (!updated) {
      return err(EventErrors.SUBSCRIPTION_NOT_FOUND());
    }

    return ok(undefined);
  }
}
