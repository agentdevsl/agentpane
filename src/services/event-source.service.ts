import * as crypto from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq, sql } from 'drizzle-orm';
import type { EventSource, EventSourceType } from '../db/schema/index.js';
import { eventSources, teams } from '../db/schema/index.js';
import { decryptToken, encryptToken } from '../lib/crypto/server-encryption.js';
import type { AppError } from '../lib/errors/base.js';
import { EventErrors } from '../lib/errors/event-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import { slugify } from '../lib/utils/slugify.js';
import type { Database } from '../types/database.js';

const log = createLogger('EventSourceService');

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type CreateEventSourceInput = {
  teamId: string;
  name: string;
  type: EventSourceType;
  webhookSecret?: string;
  config?: Record<string, unknown>;
};

export type UpdateEventSourceInput = {
  name?: string;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EventSourceService {
  constructor(private db: Database) {}

  /**
   * Create a new event source for a team.
   * Generates a URL-safe slug from the name and encrypts the webhook secret.
   */
  async create(
    input: CreateEventSourceInput
  ): Promise<Result<{ source: EventSource; plaintextSecret: string }, AppError>> {
    const { teamId, name, type, webhookSecret, config } = input;

    // Validate team exists
    const team = await this.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    });

    if (!team) {
      return err(EventErrors.TEAM_NOT_FOUND());
    }

    // Generate slug: lowercase, replace non-alphanumeric with hyphens, trim, append suffix
    const slug = generateSlug(name);

    // Auto-generate webhook secret if not provided
    const plaintextSecret = webhookSecret ?? crypto.randomBytes(32).toString('hex');
    let encryptedSecret: string;
    try {
      encryptedSecret = encryptToken(plaintextSecret);
    } catch (encryptError) {
      log.error('Failed to encrypt webhook secret', { error: encryptError });
      return err(EventErrors.SECRET_DECRYPT_FAILED());
    }

    const now = new Date().toISOString();

    const [source] = await this.db
      .insert(eventSources)
      .values({
        id: createId(),
        teamId,
        name,
        type,
        slug,
        webhookSecret: encryptedSecret,
        isEnabled: true,
        config: config ?? {},
        eventCount: 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!source) {
      return err(
        EventErrors.PROCESSING_FAILED('Failed to create event source — insert returned no rows')
      );
    }

    return ok({ source, plaintextSecret });
  }

  /**
   * Get an event source by ID.
   */
  async getById(id: string): Promise<Result<EventSource, AppError>> {
    const source = await this.db.query.eventSources.findFirst({
      where: eq(eventSources.id, id),
    });

    if (!source) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok(source);
  }

  /**
   * List all event sources for a team, ordered by creation date descending.
   */
  async listByTeam(teamId: string): Promise<Result<EventSource[], AppError>> {
    const sources = await this.db.query.eventSources.findMany({
      where: eq(eventSources.teamId, teamId),
      orderBy: [desc(eventSources.createdAt)],
    });

    return ok(sources);
  }

  /**
   * Partially update an event source.
   */
  async update(id: string, input: UpdateEventSourceInput): Promise<Result<EventSource, AppError>> {
    const updateData: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      updatedAt: new Date().toISOString(),
    };

    // Sync status field with isEnabled toggle
    if (input.isEnabled !== undefined) {
      updateData.status = input.isEnabled ? 'active' : 'disabled';
    }

    const [updated] = await this.db
      .update(eventSources)
      .set(updateData)
      .where(eq(eventSources.id, id))
      .returning();

    if (!updated) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok(updated);
  }

  /**
   * Delete an event source. Subscriptions are cascade-deleted by the FK constraint.
   */
  async delete(id: string): Promise<Result<void, AppError>> {
    const [deleted] = await this.db
      .delete(eventSources)
      .where(eq(eventSources.id, id))
      .returning({ id: eventSources.id });

    if (!deleted) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok(undefined);
  }

  /**
   * Rotate the webhook secret for an event source.
   * Generates a new random 32-byte hex secret, encrypts it, and returns
   * the plaintext so the user can copy it once.
   */
  async rotateSecret(id: string): Promise<Result<{ secret: string }, AppError>> {
    const plaintextSecret = crypto.randomBytes(32).toString('hex');
    let encryptedSecret: string;
    try {
      encryptedSecret = encryptToken(plaintextSecret);
    } catch (encryptError) {
      log.error('Failed to encrypt webhook secret during rotation', { error: encryptError });
      return err(EventErrors.SECRET_DECRYPT_FAILED());
    }

    const [updated] = await this.db
      .update(eventSources)
      .set({
        webhookSecret: encryptedSecret,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(eventSources.id, id))
      .returning({ id: eventSources.id });

    if (!updated) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok({ secret: plaintextSecret });
  }

  /**
   * Look up an event source by its URL slug (used by webhook handler).
   */
  async getBySlug(slug: string): Promise<Result<EventSource, AppError>> {
    const source = await this.db.query.eventSources.findFirst({
      where: eq(eventSources.slug, slug),
    });

    if (!source) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok(source);
  }

  /**
   * Increment the event count and update lastEventAt timestamp.
   */
  async incrementEventCount(id: string): Promise<Result<void, AppError>> {
    const [updated] = await this.db
      .update(eventSources)
      .set({
        eventCount: sql`${eventSources.eventCount} + 1`,
        lastEventAt: new Date().toISOString(),
      })
      .where(eq(eventSources.id, id))
      .returning();

    if (!updated) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    return ok(undefined);
  }

  /**
   * Decrypt and return the plaintext webhook secret for an event source.
   * Returns null if no secret is set.
   */
  decryptSecret(source: EventSource): string | null {
    if (!source.webhookSecret) {
      return null;
    }
    return decryptToken(source.webhookSecret);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe slug from a name.
 * Uses the shared slugify utility and appends a short random suffix for uniqueness.
 */
function generateSlug(name: string): string {
  return `${slugify(name)}-${createId().slice(0, 6)}`;
}
