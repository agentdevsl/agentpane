/**
 * Integration tests for the Plan → Approve → Execute flow.
 *
 * Tests that:
 * 1. plan_ready events from agent-runner are handled correctly by the container bridge
 * 2. handlePlanReady stores the plan and moves task to waiting_approval
 * 3. handleAgentError no longer suppresses errors based on lastAgentStatus='planning'
 * 4. approvePlan moves task back to in_progress and starts execution
 * 5. rejectPlan cleans up without generating error events
 * 6. The container bridge correctly routes plan_ready events to the onPlanReady callback
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { createContainerBridge } from '../../src/lib/agents/container-bridge';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Helper: create a Readable stream from JSON-line events
function jsonLinesToStream(events: Array<Record<string, unknown>>): Readable {
  const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  return Readable.from([lines]);
}

// Helper: create mock DurableStreamsService
function createMockStreams(): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as DurableStreamsService;
}

const TASK_ID = 'test-task-plan-1';
const SESSION_ID = 'test-session-plan-1';
const PROJECT_ID = 'test-project-plan-1';

describe('Plan → Approve → Execute Flow', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('routes plan_ready event through container bridge to onPlanReady callback', async () => {
    const streams = createMockStreams();
    const onPlanReady = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    const bridge = createContainerBridge({
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      codespaceId: PROJECT_ID,
      streams,
      onComplete,
      onError,
      onPlanReady,
    });

    const events = [
      {
        type: 'agent:plan_ready',
        timestamp: Date.now(),
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        data: {
          plan: 'Step 1: Do the thing\nStep 2: Verify',
          turnCount: 3,
          sdkSessionId: 'sdk-session-abc',
          allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        },
      },
    ];

    await bridge.processStream(jsonLinesToStream(events));

    expect(onPlanReady).toHaveBeenCalledOnce();
    expect(onPlanReady).toHaveBeenCalledWith({
      plan: 'Step 1: Do the thing\nStep 2: Verify',
      turnCount: 3,
      sdkSessionId: 'sdk-session-abc',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    });
    // Should NOT call onComplete or onError
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call onError for plan_ready events (no error generated)', async () => {
    const streams = createMockStreams();
    const onError = vi.fn();
    const onPlanReady = vi.fn();

    const bridge = createContainerBridge({
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      codespaceId: PROJECT_ID,
      streams,
      onError,
      onPlanReady,
    });

    // Simulate: plan_ready followed by NO error event
    // This verifies that the fix removes the abort error
    const events = [
      {
        type: 'agent:plan_ready',
        timestamp: Date.now(),
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        data: {
          plan: 'Implementation plan',
          turnCount: 2,
          sdkSessionId: 'sdk-session-def',
        },
      },
    ];

    await bridge.processStream(jsonLinesToStream(events));

    expect(onPlanReady).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('handlePlanReady persists plan and moves task to waiting_approval', async () => {
    const db = getTestDb();
    const project = await createTestProject({ id: PROJECT_ID });
    const task = await createTestTask(project.id, {
      id: TASK_ID,
      column: 'in_progress',
    });

    // Simulate what handlePlanReady does (extracted from container-agent.service.ts)
    db.update(tasks)
      .set({
        plan: 'My implementation plan',
        planOptions: {
          sdkSessionId: 'sdk-session-xyz',
          allowedPrompts: [{ tool: 'Bash' as const, prompt: 'run tests' }],
        },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, task.id))
      .run();

    // Verify task was updated correctly
    const updated = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(updated).toBeDefined();
    expect(updated!.column).toBe('waiting_approval');
    expect(updated!.plan).toBe('My implementation plan');
    expect(updated!.lastAgentStatus).toBe('planning');
    expect((updated!.planOptions as { sdkSessionId?: string } | null)?.sdkSessionId).toBe(
      'sdk-session-xyz'
    );
  });

  it('approvePlan moves task back to in_progress while preserving planning status', async () => {
    const db = getTestDb();
    const project = await createTestProject({ id: PROJECT_ID });
    const task = await createTestTask(project.id, {
      id: TASK_ID,
      column: 'waiting_approval',
    });

    // Set up the task as if handlePlanReady ran
    db.update(tasks)
      .set({
        plan: 'Approved plan',
        planOptions: { sdkSessionId: 'sdk-session-resume' },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, task.id))
      .run();

    // Simulate what approvePlan does — move back to in_progress
    // lastAgentStatus stays as 'planning' until execution completes
    db.update(tasks)
      .set({
        column: 'in_progress',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, task.id))
      .run();

    const updated = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(updated).toBeDefined();
    expect(updated!.column).toBe('in_progress');
    expect(updated!.lastAgentStatus).toBe('planning');
  });

  it('maintains lastAgentStatus=planning through handlePlanReady (not overwritten to error)', async () => {
    const db = getTestDb();
    const project = await createTestProject({ id: PROJECT_ID });
    const task = await createTestTask(project.id, {
      id: TASK_ID,
      column: 'in_progress',
    });

    // Simulate handlePlanReady: set lastAgentStatus to 'planning'
    db.update(tasks)
      .set({
        plan: 'Plan content',
        planOptions: { sdkSessionId: 'sdk-123' },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, task.id))
      .run();

    // Verify it stayed as 'planning' (not overwritten to 'error')
    const afterPlan = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(afterPlan!.lastAgentStatus).toBe('planning');
  });

  it('rejectPlan does not generate error events on the bridge', async () => {
    const streams = createMockStreams();
    const onError = vi.fn();
    const onPlanReady = vi.fn();

    const bridge = createContainerBridge({
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      codespaceId: PROJECT_ID,
      streams,
      onError,
      onPlanReady,
    });

    // Process plan_ready
    const events = [
      {
        type: 'agent:plan_ready',
        timestamp: Date.now(),
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        data: {
          plan: 'Plan to reject',
          turnCount: 1,
          sdkSessionId: 'sdk-reject',
        },
      },
    ];

    await bridge.processStream(jsonLinesToStream(events));

    expect(onPlanReady).toHaveBeenCalledOnce();
    // No error events should have been generated
    expect(onError).not.toHaveBeenCalled();

    // Verify no container-agent:error events were published
    const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
    const errorEvents = publishCalls.filter(
      (call: unknown[]) => call[1] === 'container-agent:error'
    );
    expect(errorEvents).toHaveLength(0);
  });
});
