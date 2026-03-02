import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../../src/lib/events/plugin-interface';
import type { PluginRegistry } from '../../src/lib/events/plugin-registry';
import { EventProcessingService } from '../../src/services/event-processing.service';
import type { EventSourceService } from '../../src/services/event-source.service';
import type { EventSubscriptionService } from '../../src/services/event-subscription.service';
import type { TaskService } from '../../src/services/task.service';

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
  return {
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    _insertChain: insertChain,
    _updateChain: updateChain,
  };
}

function createMockPlugin() {
  return {
    type: 'github',
    verifySignature: vi.fn().mockResolvedValue({ ok: true, value: true }),
    parseEvent: vi.fn().mockReturnValue({ ok: true, value: makeNormalizedEvent() }),
    getEventTypes: vi.fn().mockReturnValue([]),
    getTemplateVariables: vi.fn().mockReturnValue([]),
    matchesFilter: vi.fn().mockReturnValue(true),
  };
}

function createMockPluginRegistry(plugin = createMockPlugin()) {
  return {
    get: vi.fn().mockReturnValue(plugin),
    register: vi.fn(),
    getRegisteredTypes: vi.fn().mockReturnValue(['github']),
  };
}

function createMockEventSourceService() {
  return {
    getBySlug: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'source-1',
        teamId: 'team-1',
        type: 'github',
        slug: 'my-source',
        webhookSecret: 'encrypted-secret',
        isEnabled: true,
        status: 'active',
        eventCount: 0,
      },
    }),
    decryptSecret: vi.fn().mockReturnValue('plaintext-secret'),
    incrementEventCount: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function createMockSubscriptionService() {
  return {
    findMatchingSubscriptions: vi.fn().mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'sub-1',
          name: 'Test Sub',
          eventSourceId: 'source-1',
          targetProjectId: 'project-1',
          filters: [],
          promptTemplate: 'Fix: {{issue.title}}',
          autoStartAgent: false,
          taskColumn: 'backlog',
          taskPriority: 'medium',
          taskLabels: ['auto'],
        },
      ],
    }),
    incrementMatchCount: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function createMockTaskService() {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'task-1', title: 'Test task' },
    }),
    moveColumn: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    type: 'issues',
    action: 'opened',
    deliveryId: 'delivery-abc',
    source: { repo: 'owner/repo', author: 'octocat', labels: ['bug'] },
    data: { title: 'Bug report', body: 'Steps to reproduce...' },
    raw: { action: 'opened' },
    ...overrides,
  };
}

function makeHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers();
  h.set('x-hub-signature-256', 'sha256=abc123');
  for (const [key, value] of Object.entries(extra)) {
    h.set(key, value);
  }
  return h;
}

// =============================================================================
// EventProcessingService Tests
// =============================================================================

describe('EventProcessingService', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let mockPlugin: ReturnType<typeof createMockPlugin>;
  let mockPluginRegistry: ReturnType<typeof createMockPluginRegistry>;
  let mockEventSourceService: ReturnType<typeof createMockEventSourceService>;
  let mockSubscriptionService: ReturnType<typeof createMockSubscriptionService>;
  let mockTaskService: ReturnType<typeof createMockTaskService>;
  let service: EventProcessingService;

  beforeEach(() => {
    mockDb = createMockDb();
    mockPlugin = createMockPlugin();
    mockPluginRegistry = createMockPluginRegistry(mockPlugin);
    mockEventSourceService = createMockEventSourceService();
    mockSubscriptionService = createMockSubscriptionService();
    mockTaskService = createMockTaskService();

    service = new EventProcessingService(
      mockDb as never,
      mockPluginRegistry as unknown as PluginRegistry,
      mockEventSourceService as unknown as EventSourceService,
      mockSubscriptionService as unknown as EventSubscriptionService,
      mockTaskService as unknown as TaskService
    );
  });

  // ===========================================================================
  // Happy path
  // ===========================================================================

  describe('happy path', () => {
    it('processes valid webhook end-to-end and returns status=processed', async () => {
      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status).toBe('processed');
      expect(result.value.matchCount).toBe(1);
      expect(result.value.tasksCreated).toHaveLength(1);
      expect(result.value.eventLogId).toBeTruthy();

      // Verify the full pipeline was invoked
      expect(mockEventSourceService.getBySlug).toHaveBeenCalledWith('my-source');
      expect(mockPlugin.verifySignature).toHaveBeenCalledTimes(1);
      expect(mockPlugin.parseEvent).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionService.findMatchingSubscriptions).toHaveBeenCalledWith(
        'source-1',
        'issues'
      );
      expect(mockTaskService.create).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionService.incrementMatchCount).toHaveBeenCalledWith('sub-1');
      expect(mockEventSourceService.incrementEventCount).toHaveBeenCalledWith('source-1');
    });

    it('creates task with interpolated prompt template as description', async () => {
      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);

      // The prompt template is 'Fix: {{issue.title}}' and event.data.title is 'Bug report'
      const createCall = mockTaskService.create.mock.calls[0][0];
      expect(createCall.description).toBe('Fix: Bug report');
    });

    it('task title includes subscription name and event title', async () => {
      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);

      const createCall = mockTaskService.create.mock.calls[0][0];
      // buildTaskTitle creates: '[Test Sub] Bug report (owner/repo)'
      expect(createCall.title).toContain('[Test Sub]');
      expect(createCall.title).toContain('Bug report');
      expect(createCall.title).toContain('(owner/repo)');
    });

    it('passes correct labels and priority from subscription to task', async () => {
      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);

      const createCall = mockTaskService.create.mock.calls[0][0];
      expect(createCall.labels).toEqual(['auto']);
      expect(createCall.priority).toBe('medium');
      expect(createCall.projectId).toBe('project-1');
    });

    it('updates event log with task_created status after successful processing', async () => {
      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      // The db.update chain should be called to finalize the event log
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.status).toBe('task_created');
      expect(setCall.matchedSubscriptions).toEqual([{ subscriptionId: 'sub-1', taskId: 'task-1' }]);
      expect(setCall.processedAt).toBeTruthy();
    });
  });

  // ===========================================================================
  // Source validation
  // ===========================================================================

  describe('source validation', () => {
    it('returns error when source slug not found', async () => {
      mockEventSourceService.getBySlug.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_SOURCE_NOT_FOUND', message: 'Not found', status: 404 },
      });

      const result = await service.processIncomingEvent(
        'unknown-slug',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');

      // No further processing should happen
      expect(mockPlugin.verifySignature).not.toHaveBeenCalled();
      expect(mockPlugin.parseEvent).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('returns SOURCE_DISABLED when source.status is disabled', async () => {
      mockEventSourceService.getBySlug.mockResolvedValue({
        ok: true,
        value: {
          id: 'source-1',
          teamId: 'team-1',
          type: 'github',
          slug: 'my-source',
          webhookSecret: 'encrypted-secret',
          isEnabled: true,
          status: 'disabled',
          eventCount: 0,
        },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_DISABLED');

      // Should not proceed past source check
      expect(mockPluginRegistry.get).not.toHaveBeenCalled();
    });

    it('returns PLUGIN_NOT_FOUND when no plugin registered for source type', async () => {
      mockPluginRegistry.get.mockReturnValue(undefined);

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_PLUGIN_NOT_FOUND');

      // Should not attempt signature verification or parsing
      expect(mockPlugin.verifySignature).not.toHaveBeenCalled();
      expect(mockPlugin.parseEvent).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Signature verification
  // ===========================================================================

  describe('signature verification', () => {
    it('returns SIGNATURE_INVALID when plugin.verifySignature fails', async () => {
      mockPlugin.verifySignature.mockResolvedValue({
        ok: false,
        error: { code: 'SIG_FAIL', message: 'bad sig', status: 401 },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');

      // Should not proceed to parse or insert
      expect(mockPlugin.parseEvent).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('returns SIGNATURE_INVALID when verifySignature returns ok but value is false', async () => {
      mockPlugin.verifySignature.mockResolvedValue({ ok: true, value: false });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');
    });

    it('returns SECRET_DECRYPT_FAILED when decryptSecret returns null', async () => {
      mockEventSourceService.decryptSecret.mockReturnValue(null);

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SECRET_DECRYPT_FAILED');

      // verifySignature should never be called if decryption failed
      expect(mockPlugin.verifySignature).not.toHaveBeenCalled();
    });

    it('returns SECRET_DECRYPT_FAILED when decryptSecret throws', async () => {
      mockEventSourceService.decryptSecret.mockImplementation(() => {
        throw new Error('decryption error');
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SECRET_DECRYPT_FAILED');
    });

    it('skips verification when source has no webhookSecret', async () => {
      // Source has no webhookSecret — signature verification should be bypassed
      mockEventSourceService.getBySlug.mockResolvedValue({
        ok: true,
        value: {
          id: 'source-1',
          teamId: 'team-1',
          type: 'github',
          slug: 'my-source',
          webhookSecret: null,
          isEnabled: true,
          status: 'active',
          eventCount: 0,
        },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);

      // Signature verification should never be called
      expect(mockPlugin.verifySignature).not.toHaveBeenCalled();
      expect(mockEventSourceService.decryptSecret).not.toHaveBeenCalled();

      // But parsing and rest of pipeline should proceed
      expect(mockPlugin.parseEvent).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('passes signature header to plugin.verifySignature', async () => {
      const headers = makeHeaders({ 'x-hub-signature-256': 'sha256=correctsig' });

      await service.processIncomingEvent('my-source', headers, '{"action":"opened"}');

      expect(mockPlugin.verifySignature).toHaveBeenCalledWith(
        '{"action":"opened"}',
        'sha256=correctsig',
        'plaintext-secret'
      );
    });
  });

  // ===========================================================================
  // Event parsing
  // ===========================================================================

  describe('event parsing', () => {
    it('returns error when parseEvent fails', async () => {
      mockPlugin.parseEvent.mockReturnValue({
        ok: false,
        error: { code: 'EVENT_PARSE_FAILED', message: 'Invalid payload', status: 400 },
      });

      const result = await service.processIncomingEvent('my-source', makeHeaders(), 'bad-json');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_PARSE_FAILED');

      // Should not insert into event log
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Deduplication
  // ===========================================================================

  describe('deduplication', () => {
    it('returns status=duplicate when insert throws UNIQUE constraint error', async () => {
      mockDb._insertChain.values.mockImplementationOnce(() => {
        throw new Error('UNIQUE constraint failed: event_log.eventSourceId, event_log.deliveryId');
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('duplicate');
      expect(result.value.matchCount).toBe(0);
      expect(result.value.tasksCreated).toEqual([]);
      expect(result.value.eventLogId).toBe('');

      // Should not continue to subscription matching
      expect(mockSubscriptionService.findMatchingSubscriptions).not.toHaveBeenCalled();
    });

    it('returns status=duplicate for SQLITE_CONSTRAINT variant', async () => {
      mockDb._insertChain.values.mockImplementationOnce(() => {
        throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint violated');
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('duplicate');
    });

    it('returns PROCESSING_FAILED for non-unique insert errors', async () => {
      mockDb._insertChain.values.mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_PROCESSING_FAILED');
    });
  });

  // ===========================================================================
  // Subscription matching
  // ===========================================================================

  describe('subscription matching', () => {
    it('skips subscriptions where filters do not match', async () => {
      mockPlugin.matchesFilter.mockReturnValue(false);

      // Subscription has filters that the event doesn't match
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Test Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [{ field: 'repo', operator: 'equals', value: 'other/repo' }],
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'medium',
            taskLabels: ['auto'],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No tasks created since filters didn't match
      expect(result.value.tasksCreated).toHaveLength(0);
      expect(mockTaskService.create).not.toHaveBeenCalled();
    });

    it('returns status=ignored when no subscriptions match', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('ignored');
      expect(result.value.matchCount).toBe(0);
      expect(result.value.tasksCreated).toEqual([]);
    });

    it('returns error when findMatchingSubscriptions fails', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Query failed', status: 500 },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('DB_ERROR');
    });

    it('evaluates all filters on a subscription — all must pass', async () => {
      // Two filters: first passes, second fails
      mockPlugin.matchesFilter.mockReturnValueOnce(true).mockReturnValueOnce(false);

      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Multi-filter Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [
              { field: 'repo', operator: 'equals', value: 'owner/repo' },
              { field: 'labels', operator: 'contains', value: 'feature' },
            ],
            promptTemplate: 'Work on: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'medium',
            taskLabels: [],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tasksCreated).toHaveLength(0);
      expect(mockTaskService.create).not.toHaveBeenCalled();
    });

    it('creates tasks for multiple matching subscriptions', async () => {
      mockTaskService.create
        .mockResolvedValueOnce({ ok: true, value: { id: 'task-1', title: 'Task 1' } })
        .mockResolvedValueOnce({ ok: true, value: { id: 'task-2', title: 'Task 2' } });

      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Sub A',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Template A: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'high',
            taskLabels: ['a'],
          },
          {
            id: 'sub-2',
            name: 'Sub B',
            eventSourceId: 'source-1',
            targetProjectId: 'project-2',
            filters: [],
            promptTemplate: 'Template B: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'low',
            taskLabels: ['b'],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tasksCreated).toEqual(['task-1', 'task-2']);
      expect(result.value.matchCount).toBe(2);
      expect(mockTaskService.create).toHaveBeenCalledTimes(2);

      // Verify each subscription's task was created with correct params
      expect(mockTaskService.create.mock.calls[0][0]).toMatchObject({
        projectId: 'project-1',
        description: 'Template A: Bug report',
        labels: ['a'],
        priority: 'high',
      });
      expect(mockTaskService.create.mock.calls[1][0]).toMatchObject({
        projectId: 'project-2',
        description: 'Template B: Bug report',
        labels: ['b'],
        priority: 'low',
      });
    });
  });

  // ===========================================================================
  // Task column handling
  // ===========================================================================

  describe('task column handling', () => {
    it('moves task to configured column when not backlog', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'In Progress Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'in_progress',
            taskPriority: 'high',
            taskLabels: [],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      expect(mockTaskService.moveColumn).toHaveBeenCalledWith('task-1', 'in_progress');
    });

    it('does NOT move task when taskColumn is backlog', async () => {
      // Default subscription has taskColumn: 'backlog'
      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      expect(mockTaskService.moveColumn).not.toHaveBeenCalled();
    });

    it('does NOT move task when taskColumn is null (defaults to backlog)', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Null Column Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: null,
            taskPriority: 'medium',
            taskLabels: [],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      expect(mockTaskService.moveColumn).not.toHaveBeenCalled();
    });

    it('logs error but does not fail overall when moveColumn fails', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Move Fail Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'in_progress',
            taskPriority: 'medium',
            taskLabels: [],
          },
        ],
      });

      mockTaskService.moveColumn.mockResolvedValue({
        ok: false,
        error: { code: 'MOVE_FAILED', message: 'Column not found', status: 400 },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      // Processing should still succeed overall
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tasksCreated).toEqual(['task-1']);
    });
  });

  // ===========================================================================
  // Error resilience
  // ===========================================================================

  describe('error resilience', () => {
    it('continues processing when task creation fails for one subscription', async () => {
      mockTaskService.create
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'TASK_CREATE_FAILED', message: 'DB error', status: 500 },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: { id: 'task-2', title: 'Task 2' },
        });

      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Fail Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'medium',
            taskLabels: [],
          },
          {
            id: 'sub-2',
            name: 'Success Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-2',
            filters: [],
            promptTemplate: 'Work: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'medium',
            taskLabels: [],
          },
        ],
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only the second task succeeded
      expect(result.value.tasksCreated).toEqual(['task-2']);
      // Both subscriptions were matched (one failed task, one succeeded)
      expect(result.value.matchCount).toBe(2);
      expect(result.value.status).toBe('processed');

      // Both create attempts were made
      expect(mockTaskService.create).toHaveBeenCalledTimes(2);

      // incrementMatchCount should only be called for successful tasks
      expect(mockSubscriptionService.incrementMatchCount).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionService.incrementMatchCount).toHaveBeenCalledWith('sub-2');
    });

    it('logs and continues when incrementMatchCount fails', async () => {
      mockSubscriptionService.incrementMatchCount.mockResolvedValue({
        ok: false,
        error: { code: 'INCREMENT_FAILED', message: 'DB error', status: 500 },
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      // Should still succeed overall
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('processed');
      expect(result.value.tasksCreated).toEqual(['task-1']);
    });

    it('continues when event log update fails', async () => {
      mockDb._updateChain.set.mockImplementation(() => {
        throw new Error('Update failed');
      });

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      // Should still return success — event log update failure is not fatal
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('processed');
    });

    it('continues when incrementEventCount fails', async () => {
      mockEventSourceService.incrementEventCount.mockRejectedValue(
        new Error('Count increment failed')
      );

      const result = await service.processIncomingEvent(
        'my-source',
        makeHeaders(),
        '{"action":"opened"}'
      );

      // Should still succeed — event count failure is not fatal
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('processed');
    });

    it('records failed subscription match without taskId in matchedSubscriptions', async () => {
      mockTaskService.create.mockResolvedValue({
        ok: false,
        error: { code: 'TASK_CREATE_FAILED', message: 'DB error', status: 500 },
      });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      // The event log update should include the failed subscription match without a taskId
      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.matchedSubscriptions).toEqual([{ subscriptionId: 'sub-1' }]);
      expect(setCall.status).toBe('matched');
    });
  });

  // ===========================================================================
  // Event log status resolution
  // ===========================================================================

  describe('event log status resolution', () => {
    it('sets status to task_created when at least one task is created', async () => {
      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.status).toBe('task_created');
    });

    it('sets status to matched when subscriptions match but all task creations fail', async () => {
      mockTaskService.create.mockResolvedValue({
        ok: false,
        error: { code: 'TASK_CREATE_FAILED', message: 'Failed', status: 500 },
      });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.status).toBe('matched');
    });

    it('sets status to ignored when no subscriptions exist', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [],
      });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const setCall = mockDb._updateChain.set.mock.calls[0][0];
      expect(setCall.status).toBe('ignored');
    });
  });

  // ===========================================================================
  // Template interpolation edge cases
  // ===========================================================================

  describe('template interpolation', () => {
    it('handles event without title — falls back to type/action in task title', async () => {
      const eventWithoutTitle = makeNormalizedEvent({
        data: { body: 'Some body' },
      });
      mockPlugin.parseEvent.mockReturnValue({ ok: true, value: eventWithoutTitle });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const createCall = mockTaskService.create.mock.calls[0][0];
      // Without data.title, buildTaskTitle uses 'issues opened' format
      expect(createCall.title).toContain('[Test Sub]');
      expect(createCall.title).toContain('issues opened');
    });

    it('handles missing template variables gracefully with empty string', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Missing Var Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: [],
            promptTemplate: 'Issue: {{issue.title}} by {{nonexistent.var}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: 'medium',
            taskLabels: [],
          },
        ],
      });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const createCall = mockTaskService.create.mock.calls[0][0];
      // Missing variables should be replaced with empty string
      expect(createCall.description).toBe('Issue: Bug report by ');
    });
  });

  // ===========================================================================
  // Subscription with null optional fields
  // ===========================================================================

  describe('subscription with null optional fields', () => {
    it('defaults to medium priority when taskPriority is null', async () => {
      mockSubscriptionService.findMatchingSubscriptions.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'sub-1',
            name: 'Null Priority Sub',
            eventSourceId: 'source-1',
            targetProjectId: 'project-1',
            filters: null,
            promptTemplate: 'Fix: {{issue.title}}',
            autoStartAgent: false,
            taskColumn: 'backlog',
            taskPriority: null,
            taskLabels: null,
          },
        ],
      });

      await service.processIncomingEvent('my-source', makeHeaders(), '{"action":"opened"}');

      const createCall = mockTaskService.create.mock.calls[0][0];
      expect(createCall.priority).toBe('medium');
      expect(createCall.labels).toEqual([]);
    });
  });
});
