import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { AgentReviewService } from '../../src/services/container-agent/agent-review.service';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams, createMockWorktreeInit } from '../helpers/mocks';

const mockCreateSession = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: (...args: unknown[]) => mockCreateSession(...args),
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
      reasoning: 'The plan is complete and safe.',
      confidence: 0.95,
    });

  return {
    send: vi.fn().mockImplementation(async () => {
      if (options.sendError) {
        throw options.sendError;
      }
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: response }],
        },
      };
      yield { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } };
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
  planService: PlanApprovalService;
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
  const planService = new PlanApprovalService(
    deps,
    stateManager,
    createMockWorktreeInit() as any,
    startAgentFn,
    () => false,
    agentReview
  );
  agentReview.setPlanApproval(planService);
  return { planService, agentReview, startAgentFn };
}

describe('Agent approval mode', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams() as unknown as DurableStreamsService;
    stateManager = new SandboxStateManager();
    mockCreateSession.mockReset();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  it("handlePlanReady with approvalMode='agent' reviews, auto-approves, and starts execution", async () => {
    mockCreateSession.mockReturnValue(createReviewSession());
    const codespace = await createTestProject({ name: 'Agent Review Auto Approve' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      approvalMode: 'agent',
      title: 'Review this plan',
      description: 'Implement a safe feature.',
    });
    const { planService, startAgentFn } = createServices(db, streams, stateManager);

    await planService.handlePlanReady(task.id, 'session-agent-review', codespace.id, {
      plan: '1. Implement feature\n2. Add tests',
      turnCount: 3,
      sdkSessionId: 'sdk-agent-review',
    });

    await vi.waitFor(async () => {
      expect(startAgentFn).toHaveBeenCalledOnce();
    });

    const startInput = startAgentFn.mock.calls[0]?.[0] as StartAgentInput | undefined;
    expect(startInput?.sdkSessionId).toBe('sdk-agent-review');

    const reviewed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(reviewed?.column).toBe('in_progress');
    expect(reviewed?.approvedBy).toBe('agent-review');
    expect(reviewed?.agentReviewResult).toMatchObject({
      verdict: 'approve',
      reasoning: 'The plan is complete and safe.',
      confidence: 0.95,
    });
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);
  });

  it('agent review SDK throw resets task to human planning review without starting execution', async () => {
    mockCreateSession.mockReturnValue(
      createReviewSession({ sendError: new Error('review SDK failed') })
    );
    const codespace = await createTestProject({ name: 'Agent Review Fallback' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      approvalMode: 'agent',
      title: 'Fallback plan',
    });
    const { planService, startAgentFn } = createServices(db, streams, stateManager);

    await planService.handlePlanReady(task.id, 'session-agent-review-fail', codespace.id, {
      plan: 'Plan awaiting fallback',
      turnCount: 2,
      sdkSessionId: 'sdk-review-fail',
    });

    await vi.waitFor(async () => {
      const fallback = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(fallback?.column).toBe('waiting_approval');
      expect(fallback?.lastAgentStatus).toBe('planning');
    });

    expect(startAgentFn).not.toHaveBeenCalled();
    expect(stateManager.hasPendingPlan(task.id)).toBe(true);
  });
});
