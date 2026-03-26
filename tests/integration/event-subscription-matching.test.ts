import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamProjectFolders, teams } from '../../src/db/schema';
import { EventSubscriptionService } from '../../src/services/event-subscription.service';
import { createTestEventSource } from '../factories/event-source.factory';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('EventSubscriptionService Integration (IT-339 to IT-345)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: EventSubscriptionService;
  let teamId: string;
  let eventSourceId: string;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new EventSubscriptionService(db as any);

    // Create a team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `test-team-${teamId.slice(0, 6)}`,
    });

    // Create an event source belonging to the team
    const source = await createTestEventSource({ teamId });
    eventSourceId = source.id;

    // Create a codespace with a projectFolderId (factory creates 'default-folder')
    const codespace = await createTestProject();
    codespaceId = codespace.id;

    // Link the team to the codespace's project folder via teamProjectFolders
    await db.insert(teamProjectFolders).values({
      teamId,
      projectFolderId: codespace.projectFolderId!,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-339: Create subscription stored with correct defaults', async () => {
    const result = await service.create({
      name: 'My Subscription',
      eventSourceId,
      targetCodespaceId: codespaceId,
      promptTemplate: 'Handle event: {{event.type}}',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sub = result.value;
    expect(sub.name).toBe('My Subscription');
    expect(sub.eventSourceId).toBe(eventSourceId);
    expect(sub.targetCodespaceId).toBe(codespaceId);
    expect(sub.isEnabled).toBe(true);
    expect(sub.taskColumn).toBe('backlog');
    expect(sub.taskPriority).toBe('medium');
    expect(sub.promptTemplate).toBe('Handle event: {{event.type}}');
    expect(sub.autoStartAgent).toBe(false);
    expect(sub.eventTypes).toEqual([]);
    expect(sub.filters).toEqual([]);
    expect(sub.taskLabels).toEqual([]);
    expect(sub.matchedCount).toBe(0);
    expect(sub.id).toBeTruthy();
    expect(sub.createdAt).toBeTruthy();
    expect(sub.updatedAt).toBeTruthy();
  });

  it('IT-340: Subscription with eventTypes filter matches only matching event types', async () => {
    const createResult = await service.create({
      name: 'PR Only Sub',
      eventSourceId,
      targetCodespaceId: codespaceId,
      eventTypes: ['pull_request.opened', 'pull_request.closed'],
      promptTemplate: 'Handle PR: {{event.action}}',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Should match a listed event type
    const matchResult = await service.findMatchingSubscriptions(
      eventSourceId,
      'pull_request.opened'
    );
    expect(matchResult.ok).toBe(true);
    if (matchResult.ok) {
      expect(matchResult.value).toHaveLength(1);
      expect(matchResult.value[0]!.id).toBe(createResult.value.id);
    }

    // Should match the other listed event type
    const matchResult2 = await service.findMatchingSubscriptions(
      eventSourceId,
      'pull_request.closed'
    );
    expect(matchResult2.ok).toBe(true);
    if (matchResult2.ok) {
      expect(matchResult2.value).toHaveLength(1);
    }

    // Should NOT match an unlisted event type
    const noMatch = await service.findMatchingSubscriptions(eventSourceId, 'issues.opened');
    expect(noMatch.ok).toBe(true);
    if (noMatch.ok) {
      expect(noMatch.value).toHaveLength(0);
    }

    // Create a wildcard subscription (empty eventTypes) and verify it matches anything
    const wildcardResult = await service.create({
      name: 'Wildcard Sub',
      eventSourceId,
      targetCodespaceId: codespaceId,
      eventTypes: [],
      promptTemplate: 'Handle all: {{event.type}}',
    });
    expect(wildcardResult.ok).toBe(true);

    const wildcardMatch = await service.findMatchingSubscriptions(eventSourceId, 'issues.opened');
    expect(wildcardMatch.ok).toBe(true);
    if (wildcardMatch.ok) {
      expect(wildcardMatch.value).toHaveLength(1);
      expect(wildcardMatch.value[0]!.name).toBe('Wildcard Sub');
    }
  });

  it('IT-341: Subscription with JSON filters stored and retrieved correctly', async () => {
    const filters = [
      { field: 'action', operator: 'equals' as const, value: 'opened' },
      { field: 'repository.full_name', operator: 'contains' as const, value: 'agentpane' },
    ];

    const createResult = await service.create({
      name: 'Filtered Sub',
      eventSourceId,
      targetCodespaceId: codespaceId,
      filters,
      promptTemplate: 'Handle filtered: {{event.type}}',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = await service.getById(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    const retrieved = getResult.value;
    expect(retrieved.filters).toEqual(filters);
    expect(retrieved.name).toBe('Filtered Sub');
  });

  it('IT-342: Disabled subscription excluded from findMatchingSubscriptions', async () => {
    const createResult = await service.create({
      name: 'Soon Disabled',
      eventSourceId,
      targetCodespaceId: codespaceId,
      promptTemplate: 'Handle: {{event.type}}',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const subId = createResult.value.id;

    // Verify it matches while enabled
    const beforeDisable = await service.findMatchingSubscriptions(eventSourceId, 'push');
    expect(beforeDisable.ok).toBe(true);
    if (beforeDisable.ok) {
      expect(beforeDisable.value).toHaveLength(1);
    }

    // Disable it
    const updateResult = await service.update(subId, { isEnabled: false });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.value.isEnabled).toBe(false);
    }

    // Verify it no longer matches
    const afterDisable = await service.findMatchingSubscriptions(eventSourceId, 'push');
    expect(afterDisable.ok).toBe(true);
    if (afterDisable.ok) {
      expect(afterDisable.value).toHaveLength(0);
    }
  });

  it('IT-343: Delete subscription then getById returns SUBSCRIPTION_NOT_FOUND', async () => {
    const createResult = await service.create({
      name: 'To Be Deleted',
      eventSourceId,
      targetCodespaceId: codespaceId,
      promptTemplate: 'Handle: {{event.type}}',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const subId = createResult.value.id;

    // Delete the subscription
    const deleteResult = await service.delete(subId);
    expect(deleteResult.ok).toBe(true);

    // Verify getById returns error
    const getResult = await service.getById(subId);
    expect(getResult.ok).toBe(false);
    if (!getResult.ok) {
      expect(getResult.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    }
  });

  it('IT-344: Cross-team validation returns PROJECT_TEAM_MISMATCH', async () => {
    // Create a second team with no link to the codespace's project folder
    const otherTeamId = createId();
    await db.insert(teams).values({
      id: otherTeamId,
      name: 'Other Team',
      slug: `other-team-${otherTeamId.slice(0, 6)}`,
    });

    // Create an event source in the other team
    const otherSource = await createTestEventSource({ teamId: otherTeamId });

    // Try to create a subscription linking the other team's source to the codespace
    // The codespace's folder is linked to the first team, not the other team
    const result = await service.create({
      name: 'Cross Team Sub',
      eventSourceId: otherSource.id,
      targetCodespaceId: codespaceId,
      promptTemplate: 'Should fail: {{event.type}}',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EVENT_PROJECT_TEAM_MISMATCH');
    }
  });

  it('IT-345: Update subscription fields reflected in getById', async () => {
    const createResult = await service.create({
      name: 'Original Name',
      eventSourceId,
      targetCodespaceId: codespaceId,
      promptTemplate: 'Original template',
      taskPriority: 'medium',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const subId = createResult.value.id;

    // Update multiple fields
    const updateResult = await service.update(subId, {
      name: 'Updated Name',
      promptTemplate: 'Updated template: {{event.payload}}',
      taskPriority: 'high',
    });

    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.value.name).toBe('Updated Name');
      expect(updateResult.value.promptTemplate).toBe('Updated template: {{event.payload}}');
      expect(updateResult.value.taskPriority).toBe('high');
    }

    // Verify via getById
    const getResult = await service.getById(subId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value.name).toBe('Updated Name');
    expect(getResult.value.promptTemplate).toBe('Updated template: {{event.payload}}');
    expect(getResult.value.taskPriority).toBe('high');
    // Unchanged fields should remain
    expect(getResult.value.taskColumn).toBe('backlog');
    expect(getResult.value.isEnabled).toBe(true);
    // updatedAt should be a valid ISO string
    expect(getResult.value.updatedAt).toBeTruthy();
  });

  it('IT-345b: delete non-existent subscription returns NOT_FOUND', async () => {
    const result = await service.delete('nonexistent-subscription-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
  });

  it('IT-345c: update non-existent subscription returns NOT_FOUND', async () => {
    const result = await service.update('nonexistent-subscription-id', { name: 'New Name' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
  });
});
