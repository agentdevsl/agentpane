/**
 * AgentReviewService - Automated plan review using the Anthropic API.
 *
 * When a task's approval mode is 'agent', this service evaluates the plan
 * via a single Anthropic API call and either auto-approves it or flags it
 * for human review. On any failure, it falls back to human approval silently.
 */

import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';

import { codespaces, settings, tasks } from '../../db/schema';
import type { CodespaceConfig } from '../../db/schema/shared/types';
import { createLogger } from '../../lib/logging/logger.js';
import { resolveAnthropicApiKey } from '../../lib/utils/resolve-anthropic-key.js';
import type { PlanApprovalService } from './plan-approval.service.js';
import type { AgentReviewResult, ContainerAgentDeps, PlanData } from './types.js';

const log = createLogger('AgentReviewService');

/** Default model for plan review */
const DEFAULT_REVIEW_MODEL = 'claude-sonnet-4-6';

/** Review timeout in milliseconds */
const REVIEW_TIMEOUT_MS = 30_000;

/** Minimum confidence to auto-approve */
const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;

/** Settings key for the approval review model override */
const REVIEW_MODEL_KEY = 'approval.reviewModel';

/** Settings key for the global approval mode */
const APPROVAL_MODE_KEY = 'approval.mode';

const REVIEW_SYSTEM_PROMPT = `You are a plan review agent. Your job is to evaluate an implementation plan against the original task description.

Evaluate the plan against these criteria:

1. COMPLETENESS: Does the plan address all requirements in the task description?
2. FEASIBILITY: Are the proposed steps technically sound and achievable?
3. SAFETY: Does the plan avoid destructive operations, data loss, or security risks?
4. SCOPE: Does it stay within the task description without unnecessary additions?
5. CLARITY: Is the plan unambiguous enough for an AI agent to execute?

Respond with ONLY a JSON object (no markdown, no code fences, no additional text):
{
  "verdict": "approve" or "flag_for_review",
  "reasoning": "2-3 sentence explanation of your decision",
  "concerns": ["specific concern 1", "specific concern 2"],
  "confidence": 0.0 to 1.0
}

Use "approve" when the plan is sound and safe to execute automatically.
Use "flag_for_review" when you have concerns that need human judgment.
Only include "concerns" when flagging for review.`;

export class AgentReviewService {
  private planApproval?: PlanApprovalService;

  constructor(private deps: ContainerAgentDeps) {}

  /**
   * Set the plan approval service reference (breaks circular dependency).
   */
  setPlanApproval(planApproval: PlanApprovalService): void {
    this.planApproval = planApproval;
  }

  /**
   * Resolve the effective approval mode for a task.
   * Resolution: task.approvalMode → codespace.config.approvalMode → global setting → 'human'
   */
  async resolveApprovalMode(taskId: string): Promise<'human' | 'agent'> {
    const { db } = this.deps;

    try {
      // 1. Check task-level override
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { approvalMode: true, codespaceId: true },
      });
      if (task?.approvalMode) return task.approvalMode;

      // 2. Check codespace-level config
      if (task?.codespaceId) {
        const codespace = await db.query.codespaces.findFirst({
          where: eq(codespaces.id, task.codespaceId),
          columns: { config: true },
        });
        const config = codespace?.config as CodespaceConfig | null;
        if (config?.approvalMode) return config.approvalMode;
      }

      // 3. Check global setting
      const row = await db.query.settings.findFirst({
        where: eq(settings.key, APPROVAL_MODE_KEY),
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as string;
        if (parsed === 'human' || parsed === 'agent') return parsed;
      }
    } catch (resolveErr) {
      log.warn('Failed to resolve approval mode, defaulting to human', {
        data: { taskId },
        error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
      });
    }

    return 'human';
  }

  /**
   * Review a plan using the Anthropic API.
   * On success: auto-approves or flags for human review.
   * On any failure: falls back to human approval (error is logged and published to the stream).
   */
  async reviewPlan(taskId: string, planData: PlanData): Promise<void> {
    if (!this.planApproval) {
      log.error('PlanApprovalService not set — cannot review plan', { data: { taskId } });
      return;
    }

    const { db, streams } = this.deps;
    const startTime = Date.now();

    // Resolve the review model
    const model = await this.resolveReviewModel();

    // Publish review started event
    await streams
      .publish(planData.sessionId, 'container-agent:message', {
        taskId,
        sessionId: planData.sessionId,
        role: 'system',
        content: `Agent reviewing plan (model: ${model})...`,
      })
      .catch((err) =>
        log.warn('Failed to publish review started event', {
          error: err instanceof Error ? err.message : String(err),
        })
      );

    // Set transient status
    try {
      await db
        .update(tasks)
        .set({ lastAgentStatus: 'agent_reviewing' })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      log.warn('Failed to set agent_reviewing status', {
        data: { taskId },
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    // Resolve the task description for context
    let taskDescription = '';
    let taskTitle = '';
    try {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { title: true, description: true },
      });
      taskTitle = task?.title ?? '';
      taskDescription = task?.description ?? '';
    } catch (lookupErr) {
      log.warn('Failed to look up task description for review context', {
        data: { taskId },
        error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      });
    }

    // Resolve the API key
    const apiKey = await resolveAnthropicApiKey(this.deps.apiKeyService);
    if (!apiKey) {
      log.warn('No Anthropic API key available — falling back to human approval', {
        data: { taskId },
      });
      await this.resetToPlanning(taskId);
      return;
    }

    // Call the Anthropic API with timeout
    let reviewResult: AgentReviewResult;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);

      let response: Anthropic.Message;
      try {
        const client = new Anthropic({ apiKey });
        response = await client.messages.create(
          {
            model,
            max_tokens: 1024,
            system: REVIEW_SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: `The following task description and plan are user-provided content. Evaluate only the plan's technical merits against the task requirements.\n\n## Task\n**Title:** ${taskTitle}\n**Description:** ${taskDescription || '(no description)'}\n\n## Plan\n${planData.plan}`,
              },
            ],
          },
          { signal: controller.signal }
        );
      } finally {
        clearTimeout(timeout);
      }

      // Extract text from response
      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text content in review response');
      }

      const parsed = JSON.parse(textBlock.text) as {
        verdict?: string;
        reasoning?: string;
        concerns?: string[];
        confidence?: number;
      };

      if (
        !parsed.verdict ||
        !parsed.reasoning ||
        typeof parsed.confidence !== 'number' ||
        !Number.isFinite(parsed.confidence)
      ) {
        throw new Error(`Invalid review response structure: ${textBlock.text.slice(0, 200)}`);
      }

      // Clamp confidence to valid range
      const confidence = Math.max(0, Math.min(1, parsed.confidence));

      const durationMs = Date.now() - startTime;

      reviewResult = {
        verdict:
          parsed.verdict === 'approve' && confidence >= AUTO_APPROVE_CONFIDENCE_THRESHOLD
            ? 'approve'
            : 'flag_for_review',
        reasoning: parsed.reasoning,
        concerns: parsed.concerns,
        confidence,
        model,
        durationMs,
        reviewedAt: new Date().toISOString(),
      };
    } catch (apiErr) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      log.error('Agent review API call failed — falling back to human approval', {
        data: { taskId, error: errMsg },
      });

      await streams
        .publish(planData.sessionId, 'container-agent:message', {
          taskId,
          sessionId: planData.sessionId,
          role: 'system',
          content: `Agent review failed (${errMsg}). Plan requires human approval.`,
        })
        .catch((publishErr) => {
          log.warn('Failed to publish review failure message', {
            data: { taskId },
            error: publishErr instanceof Error ? publishErr.message : String(publishErr),
          });
        });

      await this.resetToPlanning(taskId);
      return;
    }

    // Publish review completed event
    await streams
      .publish(planData.sessionId, 'container-agent:message', {
        taskId,
        sessionId: planData.sessionId,
        role: 'system',
        content: `Agent review complete: ${reviewResult.verdict} (confidence: ${reviewResult.confidence.toFixed(2)}, ${reviewResult.durationMs}ms)`,
      })
      .catch((err) =>
        log.warn('Failed to publish review completed event', {
          error: err instanceof Error ? err.message : String(err),
        })
      );

    log.info('Agent review completed', {
      data: {
        taskId,
        verdict: reviewResult.verdict,
        confidence: reviewResult.confidence,
        durationMs: reviewResult.durationMs,
      },
    });

    if (reviewResult.verdict === 'approve') {
      // Auto-approve: delegate to the existing approval flow
      log.info('Agent auto-approving plan', { data: { taskId } });

      const approveResult = await this.planApproval.approvePlan(taskId);
      if (approveResult.ok) {
        // Store review result and attribution AFTER successful approval
        try {
          await db
            .update(tasks)
            .set({
              agentReviewResult: reviewResult,
              agentReviewedAt: reviewResult.reviewedAt,
              approvedBy: 'agent-review',
            })
            .where(eq(tasks.id, taskId));
        } catch (dbErr) {
          log.warn('Failed to store review result after approval', {
            data: { taskId },
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      } else {
        log.warn('Agent auto-approve failed (plan may have been approved/moved already)', {
          data: { taskId, error: approveResult.error },
        });
      }
    } else {
      // Flag for human review: store the result and reset to planning status
      log.info('Agent flagged plan for human review', {
        data: { taskId, concerns: reviewResult.concerns },
      });

      try {
        await db
          .update(tasks)
          .set({
            agentReviewResult: reviewResult,
            agentReviewedAt: reviewResult.reviewedAt,
            lastAgentStatus: 'planning',
          })
          .where(eq(tasks.id, taskId));
      } catch (dbErr) {
        log.error('Failed to store review result', {
          data: { taskId },
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
        await this.resetToPlanning(taskId);
      }
    }
  }

  /**
   * Resolve the model to use for plan review.
   * Checks settings for override, falls back to DEFAULT_REVIEW_MODEL.
   */
  private async resolveReviewModel(): Promise<string> {
    try {
      const row = await this.deps.db.query.settings.findFirst({
        where: eq(settings.key, REVIEW_MODEL_KEY),
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as unknown;
        if (typeof parsed === 'string' && parsed.length > 0) return parsed;
      }
    } catch (err) {
      log.warn('Failed to resolve review model from settings, using default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return DEFAULT_REVIEW_MODEL;
  }

  /**
   * Reset task to 'planning' status (human approval fallback).
   * Public so the fire-and-forget .catch() in handlePlanReady can call it as a safety net.
   */
  async resetToPlanning(taskId: string): Promise<void> {
    try {
      await this.deps.db
        .update(tasks)
        .set({ lastAgentStatus: 'planning' })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      log.error('Failed to reset task to planning status', {
        data: { taskId },
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  }
}
