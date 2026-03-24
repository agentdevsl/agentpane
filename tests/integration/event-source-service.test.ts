import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventSubscriptions, teams } from '../../src/db/schema';
import { EventSourceService } from '../../src/services/event-source.service';
import { createTestEventSource, createTestSubscription } from '../factories/event-source.factory';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('EventSourceService Integration (IT-149 to IT-156)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: EventSourceService;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new EventSourceService(db);

    // Create a team for FK constraints
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `test-team-${teamId.slice(0, 6)}`,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-149: creates event source with slug and encrypted webhookSecret', async () => {
    const result = await service.create({
      teamId,
      name: 'GitHub Webhook',
      type: 'github',
      webhookSecret: 'my-secret-value',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { source, plaintextSecret } = result.value;
      expect(source.slug).toMatch(/^github-webhook-/);
      expect(source.webhookSecret).toBeTruthy();
      // The stored secret should be encrypted (different from plaintext)
      expect(source.webhookSecret).not.toBe('my-secret-value');
      expect(plaintextSecret).toBe('my-secret-value');
      expect(source.status).toBe('active');
      expect(source.isEnabled).toBe(true);
    }
  });

  it('IT-150: create with nonexistent teamId returns TEAM_NOT_FOUND', async () => {
    const result = await service.create({
      teamId: 'nonexistent-team-id',
      name: 'Bad Source',
      type: 'github',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EVENT_TEAM_NOT_FOUND');
    }
  });

  it('IT-151: lists event sources for a team ordered by createdAt DESC', async () => {
    // Create 3 sources with staggered timestamps
    await createTestEventSource({
      teamId,
      name: 'Source Oldest',
      createdAt: '2025-01-01T00:00:00Z',
    });
    await createTestEventSource({
      teamId,
      name: 'Source Middle',
      createdAt: '2025-06-01T00:00:00Z',
    });
    await createTestEventSource({
      teamId,
      name: 'Source Newest',
      createdAt: '2025-12-01T00:00:00Z',
    });

    const result = await service.listByTeam(teamId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      // DESC order: newest first
      expect(result.value[0].name).toBe('Source Newest');
      expect(result.value[1].name).toBe('Source Middle');
      expect(result.value[2].name).toBe('Source Oldest');
    }
  });

  it('IT-152: update isEnabled syncs status field', async () => {
    const createResult = await service.create({
      teamId,
      name: 'Toggle Source',
      type: 'github',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sourceId = createResult.value.source.id;

    // Initially active and enabled
    expect(createResult.value.source.status).toBe('active');
    expect(createResult.value.source.isEnabled).toBe(true);

    // Disable -> status should become 'disabled'
    const disableResult = await service.update(sourceId, { isEnabled: false });
    expect(disableResult.ok).toBe(true);
    if (disableResult.ok) {
      expect(disableResult.value.isEnabled).toBe(false);
      expect(disableResult.value.status).toBe('disabled');
    }

    // Re-enable -> status should become 'active'
    const enableResult = await service.update(sourceId, { isEnabled: true });
    expect(enableResult.ok).toBe(true);
    if (enableResult.ok) {
      expect(enableResult.value.isEnabled).toBe(true);
      expect(enableResult.value.status).toBe('active');
    }
  });

  it('IT-153: deleting event source cascades to subscriptions', async () => {
    const source = await createTestEventSource({ teamId });
    const codespace = await createTestProject();

    // Create subscriptions linked to the source
    await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      name: 'Sub 1',
    });
    await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      name: 'Sub 2',
    });

    // Verify subscriptions exist
    const subsBefore = await db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, source.id),
    });
    expect(subsBefore).toHaveLength(2);

    // Delete the source
    const deleteResult = await service.delete(source.id);
    expect(deleteResult.ok).toBe(true);

    // Verify subscriptions were cascade-deleted
    const subsAfter = await db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, source.id),
    });
    expect(subsAfter).toHaveLength(0);
  });

  it('IT-154: rotateSecret updates the webhookSecret', async () => {
    const createResult = await service.create({
      teamId,
      name: 'Rotate Test',
      type: 'github',
      webhookSecret: 'original-secret',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sourceId = createResult.value.source.id;
    const originalEncrypted = createResult.value.source.webhookSecret;

    // Rotate the secret
    const rotateResult = await service.rotateSecret(sourceId);
    expect(rotateResult.ok).toBe(true);
    if (rotateResult.ok) {
      // New plaintext secret should be a 64-char hex string
      expect(rotateResult.value.secret).toMatch(/^[a-f0-9]{64}$/);
    }

    // Verify the stored secret changed
    const getResult = await service.getById(sourceId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.webhookSecret).not.toBe(originalEncrypted);
    }
  });

  it('IT-155: getBySlug finds source by slug, returns error for wrong slug', async () => {
    const source = await createTestEventSource({
      teamId,
      slug: 'my-unique-slug',
    });

    const foundResult = await service.getBySlug('my-unique-slug');
    expect(foundResult.ok).toBe(true);
    if (foundResult.ok) {
      expect(foundResult.value.id).toBe(source.id);
    }

    const notFoundResult = await service.getBySlug('nonexistent-slug');
    expect(notFoundResult.ok).toBe(false);
    if (!notFoundResult.ok) {
      expect(notFoundResult.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    }
  });

  it('IT-156: incrementEventCount atomically increments count and sets lastEventAt', async () => {
    const source = await createTestEventSource({
      teamId,
      eventCount: 5,
    });
    expect(source.eventCount).toBe(5);

    // Increment once
    const incResult = await service.incrementEventCount(source.id);
    expect(incResult.ok).toBe(true);

    // Verify count went from 5 to 6
    const getResult = await service.getById(source.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.eventCount).toBe(6);
      expect(getResult.value.lastEventAt).toBeTruthy();
    }

    // Increment again
    await service.incrementEventCount(source.id);
    const getResult2 = await service.getById(source.id);
    expect(getResult2.ok).toBe(true);
    if (getResult2.ok) {
      expect(getResult2.value.eventCount).toBe(7);
    }
  });
});
