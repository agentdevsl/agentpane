import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriptionService } from '../../src/services/event-subscription.service';
import type { Database } from '../../src/types/database';

// =============================================================================
// Mock factories
// =============================================================================

function createMockDb() {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const deleteChain = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  return {
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    delete: vi.fn().mockReturnValue(deleteChain),
    query: {
      eventSources: { findFirst: vi.fn() },
      eventSubscriptions: { findFirst: vi.fn(), findMany: vi.fn() },
      teamProjects: { findFirst: vi.fn() },
    },
    _insertChain: insertChain,
    _updateChain: updateChain,
    _deleteChain: deleteChain,
  };
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    name: 'Test Subscription',
    eventSourceId: 'source-1',
    targetProjectId: 'project-1',
    isEnabled: true,
    eventTypes: [],
    filters: [],
    promptTemplate: 'Fix: {{issue.title}}',
    autoStartAgent: false,
    taskColumn: 'backlog',
    taskPriority: 'medium',
    taskLabels: [],
    matchedCount: 0,
    lastMatchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// EventSubscriptionService Tests
// =============================================================================

describe('EventSubscriptionService', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let service: EventSubscriptionService;

  beforeEach(() => {
    mockDb = createMockDb();
    service = new EventSubscriptionService(mockDb as unknown as Database);
  });

  // ===========================================================================
  // create()
  // ===========================================================================

  describe('create()', () => {
    const baseInput = {
      name: 'My Subscription',
      eventSourceId: 'source-1',
      targetProjectId: 'project-1',
      promptTemplate: 'Fix: {{issue.title}}',
    };

    it('creates subscription with all provided fields', async () => {
      const fullInput = {
        ...baseInput,
        eventTypes: ['issues', 'pull_request'],
        filters: [{ field: 'repo', operator: 'equals' as const, value: 'owner/repo' }],
        autoStartAgent: true,
        taskColumn: 'in_progress' as const,
        taskPriority: 'high' as const,
        taskLabels: ['bug', 'auto'],
      };

      mockDb.query.eventSources.findFirst.mockResolvedValue({
        id: 'source-1',
        teamId: 'team-1',
      });
      mockDb.query.teamProjects.findFirst.mockResolvedValue({
        teamId: 'team-1',
        projectId: 'project-1',
      });

      const created = makeSubscription({
        name: fullInput.name,
        eventTypes: fullInput.eventTypes,
        filters: fullInput.filters,
        autoStartAgent: true,
        taskColumn: 'in_progress',
        taskPriority: 'high',
        taskLabels: ['bug', 'auto'],
      });
      mockDb._insertChain.returning.mockResolvedValue([created]);

      const result = await service.create(fullInput);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('My Subscription');
      expect(result.value.eventTypes).toEqual(['issues', 'pull_request']);
      expect(result.value.autoStartAgent).toBe(true);
      expect(result.value.taskColumn).toBe('in_progress');
      expect(result.value.taskPriority).toBe('high');
      expect(result.value.taskLabels).toEqual(['bug', 'auto']);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('uses defaults for optional fields (eventTypes=[], filters=[], autoStartAgent=false, taskColumn=backlog, taskPriority=medium, taskLabels=[])', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue({
        id: 'source-1',
        teamId: 'team-1',
      });
      mockDb.query.teamProjects.findFirst.mockResolvedValue({
        teamId: 'team-1',
        projectId: 'project-1',
      });

      const created = makeSubscription({ name: baseInput.name });
      mockDb._insertChain.returning.mockResolvedValue([created]);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(true);

      // Verify the values passed to insert include the defaults
      const valuesCall = mockDb._insertChain.values.mock.calls[0][0];
      expect(valuesCall.eventTypes).toEqual([]);
      expect(valuesCall.filters).toEqual([]);
      expect(valuesCall.autoStartAgent).toBe(false);
      expect(valuesCall.taskColumn).toBe('backlog');
      expect(valuesCall.taskPriority).toBe('medium');
      expect(valuesCall.taskLabels).toEqual([]);
      expect(valuesCall.isEnabled).toBe(true);
      expect(valuesCall.matchedCount).toBe(0);
    });

    it('returns SOURCE_NOT_FOUND when eventSourceId does not exist', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue(undefined);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');

      // Should not proceed to team check or insert
      expect(mockDb.query.teamProjects.findFirst).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('returns PROJECT_TEAM_MISMATCH when target project not in same team', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue({
        id: 'source-1',
        teamId: 'team-1',
      });
      mockDb.query.teamProjects.findFirst.mockResolvedValue(undefined);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_PROJECT_TEAM_MISMATCH');

      // Should not proceed to insert
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('returns SUBSCRIPTION_NOT_FOUND when insert returns empty', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue({
        id: 'source-1',
        teamId: 'team-1',
      });
      mockDb.query.teamProjects.findFirst.mockResolvedValue({
        teamId: 'team-1',
        projectId: 'project-1',
      });
      mockDb._insertChain.returning.mockResolvedValue([]);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    });

    it('generates a unique ID and timestamps for new subscription', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue({
        id: 'source-1',
        teamId: 'team-1',
      });
      mockDb.query.teamProjects.findFirst.mockResolvedValue({
        teamId: 'team-1',
        projectId: 'project-1',
      });
      mockDb._insertChain.returning.mockResolvedValue([makeSubscription()]);

      await service.create(baseInput);

      const valuesCall = mockDb._insertChain.values.mock.calls[0][0];
      expect(valuesCall.id).toBeTruthy();
      expect(typeof valuesCall.id).toBe('string');
      expect(valuesCall.createdAt).toBeTruthy();
      expect(valuesCall.updatedAt).toBeTruthy();
    });
  });

  // ===========================================================================
  // getById()
  // ===========================================================================

  describe('getById()', () => {
    it('returns subscription when found', async () => {
      const sub = makeSubscription();
      mockDb.query.eventSubscriptions.findFirst.mockResolvedValue(sub);

      const result = await service.getById('sub-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('sub-1');
      expect(result.value.name).toBe('Test Subscription');
    });

    it('returns SUBSCRIPTION_NOT_FOUND when not found', async () => {
      mockDb.query.eventSubscriptions.findFirst.mockResolvedValue(undefined);

      const result = await service.getById('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    });
  });

  // ===========================================================================
  // listBySource()
  // ===========================================================================

  describe('listBySource()', () => {
    it('returns array of subscriptions', async () => {
      const subs = [
        makeSubscription({ id: 'sub-1' }),
        makeSubscription({ id: 'sub-2', name: 'Second Subscription' }),
      ];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.listBySource('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0].id).toBe('sub-1');
      expect(result.value[1].id).toBe('sub-2');
    });

    it('returns empty array when none exist', async () => {
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue([]);

      const result = await service.listBySource('source-no-subs');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });

  // ===========================================================================
  // listByProject()
  // ===========================================================================

  describe('listByProject()', () => {
    it('returns array of subscriptions', async () => {
      const subs = [
        makeSubscription({ id: 'sub-1', targetProjectId: 'project-1' }),
        makeSubscription({ id: 'sub-3', targetProjectId: 'project-1', name: 'Third' }),
      ];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.listByProject('project-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0].id).toBe('sub-1');
      expect(result.value[1].id).toBe('sub-3');
    });

    it('returns empty array when none exist', async () => {
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue([]);

      const result = await service.listByProject('project-no-subs');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });

  // ===========================================================================
  // update()
  // ===========================================================================

  describe('update()', () => {
    it('updates provided fields only', async () => {
      const updated = makeSubscription({ name: 'Updated Name', isEnabled: false });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      const result = await service.update('sub-1', {
        name: 'Updated Name',
        isEnabled: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('Updated Name');
      expect(result.value.isEnabled).toBe(false);

      // Verify set was called with the update data
      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.name).toBe('Updated Name');
      expect(setCall.isEnabled).toBe(false);
      expect(setCall.updatedAt).toBeTruthy();
    });

    it('filters out undefined values', async () => {
      const updated = makeSubscription({ name: 'Only Name Updated' });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      const result = await service.update('sub-1', {
        name: 'Only Name Updated',
        isEnabled: undefined,
        eventTypes: undefined,
        promptTemplate: undefined,
      });

      expect(result.ok).toBe(true);

      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.name).toBe('Only Name Updated');
      expect(setCall).not.toHaveProperty('isEnabled');
      expect(setCall).not.toHaveProperty('eventTypes');
      expect(setCall).not.toHaveProperty('promptTemplate');
      // updatedAt is always included
      expect(setCall.updatedAt).toBeTruthy();
    });

    it('returns SUBSCRIPTION_NOT_FOUND when ID does not exist', async () => {
      mockDb._updateChain.returning.mockResolvedValue([]);

      const result = await service.update('nonexistent', { name: 'New Name' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    });

    it('updates eventTypes and filters together', async () => {
      const newFilters = [{ field: 'repo', operator: 'equals' as const, value: 'new/repo' }];
      const newTypes = ['push', 'release'];
      const updated = makeSubscription({ eventTypes: newTypes, filters: newFilters });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      const result = await service.update('sub-1', {
        eventTypes: newTypes,
        filters: newFilters,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.eventTypes).toEqual(['push', 'release']);
      expect(result.value.filters).toEqual(newFilters);
    });
  });

  // ===========================================================================
  // delete()
  // ===========================================================================

  describe('delete()', () => {
    it('deletes and returns ok(undefined)', async () => {
      mockDb._deleteChain.returning.mockResolvedValue([{ id: 'sub-1' }]);

      const result = await service.delete('sub-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeUndefined();
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });

    it('returns SUBSCRIPTION_NOT_FOUND when ID does not exist', async () => {
      mockDb._deleteChain.returning.mockResolvedValue([]);

      const result = await service.delete('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    });
  });

  // ===========================================================================
  // findMatchingSubscriptions()
  // ===========================================================================

  describe('findMatchingSubscriptions()', () => {
    it('returns matching subscriptions for specific event type', async () => {
      const subs = [makeSubscription({ id: 'sub-1', eventTypes: ['issues', 'pull_request'] })];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'issues');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('sub-1');
    });

    it('empty eventTypes array acts as wildcard (matches all types)', async () => {
      const subs = [makeSubscription({ id: 'sub-wildcard', eventTypes: [] })];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'any_event_type');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('sub-wildcard');
    });

    it('filters out subscriptions that do not include the given event type', async () => {
      const subs = [
        makeSubscription({ id: 'sub-match', eventTypes: ['issues', 'pull_request'] }),
        makeSubscription({ id: 'sub-nomatch', eventTypes: ['push', 'release'] }),
      ];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'issues');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('sub-match');
    });

    it('returns only subscriptions whose eventTypes include the given type', async () => {
      const subs = [
        makeSubscription({ id: 'sub-a', eventTypes: ['push'] }),
        makeSubscription({ id: 'sub-b', eventTypes: ['issues', 'push'] }),
        makeSubscription({ id: 'sub-c', eventTypes: ['release'] }),
      ];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'push');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.map((s: { id: string }) => s.id)).toEqual(['sub-a', 'sub-b']);
    });

    it('returns empty array when no subscriptions match', async () => {
      const subs = [makeSubscription({ id: 'sub-1', eventTypes: ['push'] })];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'issues');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it('returns empty array when no subscriptions exist for the source', async () => {
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue([]);

      const result = await service.findMatchingSubscriptions('source-empty', 'issues');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it('returns subscriptions when eventTypes is null (treated as wildcard)', async () => {
      const subs = [makeSubscription({ id: 'sub-null-types', eventTypes: null })];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'any_event');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('sub-null-types');
    });

    it('mixes wildcard and specific subscriptions correctly', async () => {
      const subs = [
        makeSubscription({ id: 'sub-wildcard', eventTypes: [] }),
        makeSubscription({ id: 'sub-specific-match', eventTypes: ['issues'] }),
        makeSubscription({ id: 'sub-specific-nomatch', eventTypes: ['push'] }),
        makeSubscription({ id: 'sub-null-wildcard', eventTypes: null }),
      ];
      mockDb.query.eventSubscriptions.findMany.mockResolvedValue(subs);

      const result = await service.findMatchingSubscriptions('source-1', 'issues');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
      const ids = result.value.map((s: { id: string }) => s.id);
      expect(ids).toContain('sub-wildcard');
      expect(ids).toContain('sub-specific-match');
      expect(ids).toContain('sub-null-wildcard');
      expect(ids).not.toContain('sub-specific-nomatch');
    });
  });

  // ===========================================================================
  // incrementMatchCount()
  // ===========================================================================

  describe('incrementMatchCount()', () => {
    it('updates match count and lastMatchedAt', async () => {
      const updated = makeSubscription({
        matchedCount: 1,
        lastMatchedAt: '2026-01-01T12:00:00.000Z',
      });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      const result = await service.incrementMatchCount('sub-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeUndefined();
      expect(mockDb.update).toHaveBeenCalledTimes(1);

      // Verify set was called with the SQL increment and a timestamp
      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.matchedCount).toBeTruthy();
      expect(setCall.lastMatchedAt).toBeTruthy();
    });

    it('returns SUBSCRIPTION_NOT_FOUND when ID does not exist', async () => {
      mockDb._updateChain.returning.mockResolvedValue([]);

      const result = await service.incrementMatchCount('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    });
  });
});
