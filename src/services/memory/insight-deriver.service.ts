/**
 * InsightDeriverService - Claude-powered insight derivation from agent conversations.
 *
 * Uses the Claude Agent SDK for cost-efficient insight extraction.
 * Uses Haiku model for cost efficiency. Reads captured messages from the DB,
 * sends them to Claude via Agent SDK for summarization, and stores the resulting insights.
 *
 * Supports structured JSON output with categories and action types (INSERT/UPDATE/DELETE/SKIP)
 * to enable deduplication and consolidation of existing insights.
 */

import { agentPrompt } from '../../lib/agents/agent-sdk-utils.js';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { Insight, TaskOutcome } from './types.js';

const log = createLogger('InsightDeriverService');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const DERIVATION_PROMPT = `You are analyzing an agent conversation to extract memory insights. You will also receive existing insights to avoid duplicates.

## Existing Insights
{{existingInsights}}

## Conversation
{{conversation}}

## Task Outcome
{{taskOutcome}}

## Execution Traces
{{executionTraces}}

## Instructions

Analyze the conversation and return a JSON array. For each insight:
1. Decide the action: "INSERT" (new insight), "UPDATE" (refine existing), "DELETE" (existing is wrong/outdated), or "SKIP" (already covered)
2. Assign a category: "pattern", "anti_pattern", "decision", "architecture", or "error_lesson"
3. For UPDATE/DELETE, include the existing insight ID

Focus on:
- Error lessons: What failed and why? Generalize to a reusable principle.
- Anti-patterns: What approaches should be avoided?
- Patterns: What approaches worked well?
- Architecture decisions: What structural choices were made?
- Decisions: What trade-offs or choices were evaluated?
- If task outcome data is available, evaluate whether the injected insights were helpful or misleading given the outcome.
- For failed tasks, consider whether any injected insight may have been incorrect or outdated.
- Use execution trace data (tool usage patterns, files modified, errors) to identify recurring tool patterns or common failure modes worth capturing as insights.

Return ONLY a JSON array:
\`\`\`json
[
  { "action": "INSERT", "content": "...", "category": "error_lesson" },
  { "action": "UPDATE", "id": "existing-id", "content": "updated content", "category": "pattern" },
  { "action": "DELETE", "id": "existing-id", "reason": "no longer accurate" },
  { "action": "SKIP", "id": "existing-id" }
]
\`\`\`
`;

type InsightCategory = 'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson';

interface ParsedInsightAction {
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'SKIP';
  id?: string;
  content?: string;
  category?: InsightCategory;
  reason?: string;
}

export class InsightDeriverService {
  constructor(private store: MemoryStoreService) {}

  /**
   * Derive insights from a completed memory session.
   *
   * Reads all messages for the session, fetches existing insights for dedup,
   * sends them to Claude Haiku via the Agent SDK for structured analysis,
   * then processes INSERT/UPDATE/DELETE/SKIP actions accordingly.
   */
  async deriveInsights(
    memorySessionId: string,
    codespaceId: string,
    outcome?: TaskOutcome
  ): Promise<
    Result<
      { insightsCreated: number; insightsUpdated: number; insightsDeleted: number },
      MemoryError
    >
  > {
    try {
      // 1. Read messages from DB
      const messagesResult = await this.store.getMessages(memorySessionId);
      if (!messagesResult.ok) {
        return messagesResult;
      }

      const messages = messagesResult.value;
      if (messages.length === 0) {
        log.info('No messages to derive insights from', { data: { memorySessionId } });
        return ok({ insightsCreated: 0, insightsUpdated: 0, insightsDeleted: 0 });
      }

      // 2. Fetch existing insights for dedup/consolidation context (large window, exclude rejected)
      const existingInsightsResult = await this.store.getInsights(codespaceId, {
        page: 1,
        size: 500,
      });
      const existingInsights: Insight[] = existingInsightsResult.ok
        ? existingInsightsResult.value.filter((i) => i.status !== 'rejected')
        : [];

      const existingInsightsText =
        existingInsights.length > 0
          ? existingInsights
              .map((i) => `- [${i.id}] (${i.category ?? 'uncategorized'}) ${i.content}`)
              .join('\n')
          : 'No existing insights';

      // 3. Format conversation for Claude (limit to ~100k chars to stay within context window)
      const MAX_CONVERSATION_CHARS = 100_000;
      let conversationText = '';
      for (const m of messages) {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const line = `${role}: ${m.content}\n\n`;
        if (conversationText.length + line.length > MAX_CONVERSATION_CHARS) break;
        conversationText += line;
      }

      // Extract trace summaries from message metadata
      const toolUsage = new Map<string, { success: number; error: number }>();
      const allFilesModified = new Set<string>();
      let totalErrors = 0;

      for (const m of messages) {
        const meta = m.metadata as Record<string, unknown> | null;
        if (!meta?.trace) continue;
        const trace = meta.trace as {
          toolCalls?: Array<{ tool: string; status: string }>;
          filesModified?: string[];
          errorCount?: number;
        };
        if (trace.toolCalls) {
          for (const call of trace.toolCalls) {
            const stats = toolUsage.get(call.tool) ?? { success: 0, error: 0 };
            if (call.status === 'success') stats.success++;
            else stats.error++;
            toolUsage.set(call.tool, stats);
          }
        }
        if (trace.filesModified) {
          for (const f of trace.filesModified) allFilesModified.add(f);
        }
        if (trace.errorCount) totalErrors += trace.errorCount;
      }

      let traceText = '';
      if (toolUsage.size > 0) {
        const toolLines = [...toolUsage.entries()]
          .sort((a, b) => b[1].success + b[1].error - (a[1].success + a[1].error))
          .map(([tool, stats]) => `- ${tool}: ${stats.success} success, ${stats.error} error`)
          .join('\n');
        traceText += `\nTool usage:\n${toolLines}`;
      }
      if (allFilesModified.size > 0) {
        traceText += `\nFiles modified: ${[...allFilesModified].slice(0, 20).join(', ')}`;
      }
      if (totalErrors > 0) {
        traceText += `\nTotal errors encountered: ${totalErrors}`;
      }

      // Build outcome context if available
      let outcomeText = 'No outcome data available';
      if (outcome) {
        const parts = [`Status: ${outcome.status}`];
        if (outcome.tokensUsed != null) parts.push(`Tokens used: ${outcome.tokensUsed}`);
        if (outcome.turnsUsed != null) parts.push(`Turns used: ${outcome.turnsUsed}`);
        if (outcome.insightIdsUsed?.length) {
          parts.push(`Insights injected: ${outcome.insightIdsUsed.join(', ')}`);
        }
        outcomeText = parts.join('\n');
      }

      const prompt = DERIVATION_PROMPT.replace('{{existingInsights}}', existingInsightsText)
        .replace('{{conversation}}', conversationText)
        .replace('{{taskOutcome}}', outcomeText)
        .replace('{{executionTraces}}', traceText || 'No trace data available');

      // 4. Call Claude Haiku via Agent SDK for insight extraction
      const response = await agentPrompt(prompt, { model: HAIKU_MODEL });

      // 5. Parse structured JSON response
      const responseText = response.text;
      const actions = this.parseActions(responseText);

      if (actions.length === 0) {
        log.info('No insight actions extracted from conversation', {
          data: { memorySessionId },
        });
        return ok({ insightsCreated: 0, insightsUpdated: 0, insightsDeleted: 0 });
      }

      // 6. Process each action
      let insightsCreated = 0;
      let insightsUpdated = 0;
      let insightsDeleted = 0;

      for (const action of actions) {
        switch (action.action) {
          case 'INSERT': {
            if (!action.content) {
              log.warn('Skipping INSERT action with no content', { data: { memorySessionId } });
              break;
            }

            // Dedup check: if any existing insight has >60% word overlap, treat as UPDATE
            const contentToCheck = action.content;
            const overlappingInsight = existingInsights.find((existing) =>
              this.hasSignificantOverlap(contentToCheck, existing.content)
            );

            if (overlappingInsight) {
              // Treat as UPDATE instead
              const updateResult = await this.store.updateInsight(overlappingInsight.id, {
                content: action.content,
                category: action.category ?? undefined,
              });
              if (updateResult.ok) {
                insightsUpdated++;
              } else {
                log.warn('Failed to update overlapping insight', {
                  error: new Error(String(updateResult.error)),
                  data: { insightId: overlappingInsight.id, memorySessionId },
                });
              }
            } else {
              const result = await this.store.insertInsight({
                codespaceId,
                content: action.content,
                source: 'agent_derived',
                sourceSessionId: memorySessionId,
                status: 'pending_review',
                category: action.category ?? undefined,
              });
              if (result.ok) {
                insightsCreated++;
              } else {
                log.warn('Failed to store derived insight', {
                  error: new Error(String(result.error)),
                  data: { memorySessionId, codespaceId },
                });
              }
            }
            break;
          }

          case 'UPDATE': {
            if (!action.id || !action.content) {
              log.warn('Skipping UPDATE action with missing id or content', {
                data: { memorySessionId, hasId: !!action.id, hasContent: !!action.content },
              });
              break;
            }
            const existingForUpdate = existingInsights.find((i) => i.id === action.id);
            if (!existingForUpdate) {
              log.warn('Skipping UPDATE action with unknown insight ID (possible hallucination)', {
                data: { id: action.id, memorySessionId },
              });
              break;
            }
            const updateResult = await this.store.updateInsight(action.id, {
              content: action.content,
              category: action.category ?? undefined,
            });
            if (updateResult.ok) {
              insightsUpdated++;
            } else {
              log.warn('Failed to update insight', {
                error: new Error(String(updateResult.error)),
                data: { insightId: action.id, memorySessionId },
              });
            }
            break;
          }

          case 'DELETE': {
            if (!action.id) {
              log.warn('Skipping DELETE action with no id', { data: { memorySessionId } });
              break;
            }
            const existingForDelete = existingInsights.find((i) => i.id === action.id);
            if (!existingForDelete) {
              log.warn('Skipping DELETE action with unknown insight ID (possible hallucination)', {
                data: { id: action.id, memorySessionId },
              });
              break;
            }
            const deleteResult = await this.store.deleteInsight(action.id);
            if (deleteResult.ok) {
              insightsDeleted++;
            } else {
              log.warn('Failed to delete insight', {
                error: new Error(String(deleteResult.error)),
                data: { insightId: action.id, memorySessionId },
              });
            }
            break;
          }

          case 'SKIP':
            // Do nothing
            break;
        }
      }

      log.info('Derived insights from session', {
        data: {
          memorySessionId,
          codespaceId,
          insightsCreated,
          insightsUpdated,
          insightsDeleted,
          totalActions: actions.length,
        },
      });

      return ok({ insightsCreated, insightsUpdated, insightsDeleted });
    } catch (error) {
      log.error('Insight derivation failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { memorySessionId, codespaceId },
      });
      return err(
        MemoryErrors.DERIVATION_ERROR(error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * Parse structured JSON actions from Claude's response.
   * Uses the same pattern as DreamService.parseSuggestions.
   */
  private parseActions(text: string): ParsedInsightAction[] {
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const jsonStr = jsonMatch[1] ?? jsonMatch[0];
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) return [];

      const validActions = new Set(['INSERT', 'UPDATE', 'DELETE', 'SKIP']);
      const validCategories = new Set([
        'pattern',
        'anti_pattern',
        'decision',
        'architecture',
        'error_lesson',
      ]);

      return parsed
        .filter(
          (item: unknown): item is ParsedInsightAction =>
            typeof item === 'object' &&
            item !== null &&
            'action' in item &&
            validActions.has((item as Record<string, unknown>).action as string)
        )
        .map((item) => ({
          action: item.action,
          id: typeof item.id === 'string' ? item.id : undefined,
          content: typeof item.content === 'string' ? item.content : undefined,
          category: validCategories.has(item.category as string)
            ? (item.category as InsightCategory)
            : undefined,
          reason: typeof item.reason === 'string' ? item.reason : undefined,
        }));
    } catch (parseError) {
      log.warn('Failed to parse insight actions from Claude response', {
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
        data: { textLength: text.length, textPreview: text.slice(0, 200) },
      });
      return [];
    }
  }

  /**
   * Check if two pieces of content have significant word overlap.
   * Used for deduplication: if >threshold of words overlap, the insights are
   * considered duplicates.
   */
  private hasSignificantOverlap(content1: string, content2: string, threshold = 0.6): boolean {
    const words1 = new Set(
      content1
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
    const words2 = new Set(
      content2
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
    if (words1.size === 0 || words2.size === 0) return false;
    const intersection = [...words1].filter((w) => words2.has(w)).length;
    const union = words1.size + words2.size - intersection;
    return union > 0 && intersection / union >= threshold;
  }
}
