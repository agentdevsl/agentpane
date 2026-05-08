import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, tasks } from '../../src/db/schema';
import { AgentReviewService } from '../../src/services/container-agent/agent-review.service';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSetting } from '../factories/settings.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams, createMockWorktreeInit } from '../helpers/mocks';

const sdkMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: sdkMocks.createSession,
}));

type ReviewSessionOptions = {
  response?: string;
  sendError?: Error;
};

function createReviewSession(options: ReviewSessionOptions = {}) {
  const response =
    options.response ??
    JSON.stringify({
      verdict: 'approve',
      reasoning: 'The plan is complete, feasible, and safe.',
      confidence: 0.96,
    });

  return {
    send: vi.fn().mockImplementation(async () => {
      if (options.sendError) throw options.sendError;
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 20, output_tokens: 8 },
          content: [{ type: 'text', text: response }],
        },
      };
      yield { type: 'result', usage: { input_tokens: 20, output_tokens: 8 } };
    }),
    close: vi.fn(),
  };
}

function createServices(
  db: ReturnType<typeof getTestDb>,
  streams: DurableStreamsService,
  stateManager: SandboxStateManager,
  startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined })
): {
  agentReview: AgentReviewService;
  startAgentFn: typeof startAgentFn;
} {
  const deps = {
    db,
    streams,
    provider: { get: vi.fn() },
    apiKeyService: { getDecryptedKey: vi.fn().mockResolvedValue(null) },
  } as any;
  const agentReview = new AgentReviewService(deps);
  const planApproval = new PlanApprovalService(
    deps,
    stateManager,
    createMockWorktreeInit() as any,
    startAgentFn,
    () => false,
    agentReview
  );
  agentReview.setPlanApproval(planApproval);
  return { agentReview, startAgentFn };
}

describe('AgentReviewService integration', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: ReturnType<typeof createInMemoryStreams>;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams();
    stateManager = new SandboxStateManager();
    sdkMocks.createSession.mockReset();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  it('resolves approval mode from task, codespace config, global setting, then human fallback', async () => {
    const taskOverrideProject = await createTestProject({ name: 'Task approval override' });
    const taskOverride = await createTestTask(taskOverrideProject.id, {
      approvalMode: 'agent',
    });
    const codespaceOverrideProject = await createTestProject({
      name: 'Codespace approval override',
      config: { approvalMode: 'agent' },
    });
    const codespaceOverride = await createTestTask(codespaceOverrideProject.id);
    const globalProject = await createTestProject({ name: 'Global approval setting' });
    const globalTask = await createTestTask(globalProject.id);
    const fallbackProject = await createTestProject({ name: 'Fallback approval mode' });
    const fallbackTask = await createTestTask(fallbackProject.id);
    await createTestSetting({ key: 'approval.mode', value: JSON.stringify('agent') });

    const { agentReview } = createServices(db, streams, stateManager);

    await expect(agentReview.resolveApprovalMode(taskOverride.id)).resolves.toBe('agent');
    await expect(agentReview.resolveApprovalMode(codespaceOverride.id)).resolves.toBe('agent');
    await expect(agentReview.resolveApprovalMode(globalTask.id)).resolves.toBe('agent');

    await db.delete(settings).where(eq(settings.key, 'approval.mode'));
    await createTestSetting({ key: 'approval.mode', value: JSON.stringify('invalid-mode') });
    await expect(agentReview.resolveApprovalMode(fallbackTask.id)).resolves.toBe('human');
  });

  it('uses review model setting, stores usage, and auto-approves through the real plan approval flow', async () => {
    sdkMocks.createSession.mockReturnValue(createReviewSession());
    await createTestSetting({
      key: 'approval.reviewModel',
      value: JSON.stringify('claude-review-model-test'),
    });
    const project = await createTestProject({ name: 'Agent Review Integration Auto' });
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
      approvalMode: 'agent',
      plan: '1. Implement safely\n2. Add integration tests',
      title: 'Auto-review this plan',
      description: 'The plan should be safe and test-backed.',
    });
    const { agentReview, startAgentFn } = createServices(db, streams, stateManager);
    stateManager.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'session-agent-review-integration',
      codespaceId: project.id,
      plan: task.plan ?? '',
      turnCount: 2,
      sdkSessionId: 'sdk-agent-review-integration',
    });

    await agentReview.reviewPlan(task.id, {
      taskId: task.id,
      sessionId: 'session-agent-review-integration',
      codespaceId: project.id,
      plan: task.plan ?? '',
      turnCount: 2,
      sdkSessionId: 'sdk-agent-review-integration',
    });

    const sessionOptions = sdkMocks.createSession.mock.calls[0]?.[0];
    expect(sessionOptions).toMatchObject({
      model: 'claude-review-model-test',
      allowedTools: [],
    });
    expect(startAgentFn).toHaveBeenCalledOnce();
    const startInput = startAgentFn.mock.calls[0]?.[0] as StartAgentInput | undefined;
    expect(startInput?.sdkSessionId).toBe('sdk-agent-review-integration');

    const reviewed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(reviewed?.column).toBe('in_progress');
    expect(reviewed?.approvedBy).toBe('agent-review');
    expect(reviewed?.agentReviewResult).toMatchObject({
      verdict: 'approve',
      confidence: 0.96,
      usage: { inputTokens: 20, outputTokens: 8 },
    });
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);
  });

  it('flags low-confidence approvals for human review without starting execution', async () => {
    sdkMocks.createSession.mockReturnValue(
      createReviewSession({
        response: JSON.stringify({
          verdict: 'approve',
          reasoning: 'The approach is plausible but confidence is too low.',
          concerns: ['Needs a human check before execution'],
          confidence: 0.42,
        }),
      })
    );
    const project = await createTestProject({ name: 'Agent Review Integration Flag' });
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
      approvalMode: 'agent',
      plan: 'A vague plan that should not auto-approve.',
      title: 'Flag this plan',
    });
    const { agentReview, startAgentFn } = createServices(db, streams, stateManager);

    await agentReview.reviewPlan(task.id, {
      taskId: task.id,
      sessionId: 'session-agent-review-flag',
      codespaceId: project.id,
      plan: task.plan ?? '',
      turnCount: 1,
    });

    expect(startAgentFn).not.toHaveBeenCalled();
    const reviewed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(reviewed?.column).toBe('waiting_approval');
    expect(reviewed?.lastAgentStatus).toBe('planning');
    expect(reviewed?.approvedBy).toBeNull();
    expect(reviewed?.agentReviewResult).toMatchObject({
      verdict: 'flag_for_review',
      confidence: 0.42,
      concerns: ['Needs a human check before execution'],
    });

    const events = streams.getEvents('session-agent-review-flag');
    expect(events.map((event) => event.type)).toEqual([
      'container-agent:message',
      'container-agent:message',
    ]);
    expect(events[1]?.data).toMatchObject({
      role: 'approval',
      content: expect.stringContaining('flagged by agent for human review'),
    });
  });

  it('falls back to human planning review when the model returns malformed JSON', async () => {
    sdkMocks.createSession.mockReturnValue(createReviewSession({ response: 'not-json' }));
    const project = await createTestProject({ name: 'Agent Review Integration Fallback' });
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
      approvalMode: 'agent',
      plan: 'Plan awaiting review fallback.',
      lastAgentStatus: 'agent_reviewing',
    });
    const { agentReview, startAgentFn } = createServices(db, streams, stateManager);

    await agentReview.reviewPlan(task.id, {
      taskId: task.id,
      sessionId: 'session-agent-review-malformed',
      codespaceId: project.id,
      plan: task.plan ?? '',
      turnCount: 1,
    });

    expect(startAgentFn).not.toHaveBeenCalled();
    const fallback = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(fallback?.column).toBe('waiting_approval');
    expect(fallback?.lastAgentStatus).toBe('planning');
    expect(fallback?.agentReviewResult).toBeNull();

    const events = streams.getEvents('session-agent-review-malformed');
    expect(events[1]?.data).toMatchObject({
      role: 'approval',
      content: expect.stringContaining('Agent review failed'),
    });
  });
});
