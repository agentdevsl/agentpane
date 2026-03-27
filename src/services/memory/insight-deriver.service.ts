/**
 * InsightDeriverService - Claude-powered insight derivation from agent conversations.
 *
 * Uses the Claude Agent SDK for cost-efficient insight extraction.
 * Uses Haiku model for cost efficiency. Reads captured messages from the DB,
 * sends them to Claude via Agent SDK for summarization, and stores the resulting insights.
 */

import { agentPrompt } from '../../lib/agents/agent-sdk-utils.js';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { MemoryStoreService } from './memory-store.service.js';

const log = createLogger('InsightDeriverService');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const DERIVATION_PROMPT = `Analyze the following agent conversation and extract key insights, patterns, and conclusions that would be useful for future tasks in this codebase. Return each insight as a separate line starting with "- ".

Focus on:
- Technical patterns and architecture decisions
- Common pitfalls or errors encountered
- Successful approaches that worked well
- Codebase-specific knowledge

Conversation:
`;

export class InsightDeriverService {
  constructor(private store: MemoryStoreService) {}

  /**
   * Derive insights from a completed memory session.
   *
   * Reads all messages for the session, sends them to Claude Haiku via
   * the Agent SDK for summarization, then stores each extracted insight in the DB.
   */
  async deriveInsights(
    memorySessionId: string,
    codespaceId: string
  ): Promise<Result<{ insightsCreated: number }, MemoryError>> {
    try {
      // 1. Read messages from DB
      const messagesResult = await this.store.getMessages(memorySessionId);
      if (!messagesResult.ok) {
        return messagesResult;
      }

      const messages = messagesResult.value;
      if (messages.length === 0) {
        log.info('No messages to derive insights from', { data: { memorySessionId } });
        return ok({ insightsCreated: 0 });
      }

      // 2. Format conversation for Claude (limit to ~100k chars to stay within context window)
      const MAX_CONVERSATION_CHARS = 100_000;
      let conversationText = '';
      for (const m of messages) {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const line = `${role}: ${m.content}\n\n`;
        if (conversationText.length + line.length > MAX_CONVERSATION_CHARS) break;
        conversationText += line;
      }

      const prompt = `${DERIVATION_PROMPT}${conversationText}`;

      // 3. Call Claude Haiku via Agent SDK for insight extraction
      const response = await agentPrompt(prompt, { model: HAIKU_MODEL });

      // 4. Parse response — extract lines starting with "- "
      const responseText = response.text;

      const insightLines = responseText
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.startsWith('- '))
        .map((line: string) => line.slice(2).trim())
        .filter((line: string) => line.length > 0);

      if (insightLines.length === 0) {
        log.info('No insights extracted from conversation', { data: { memorySessionId } });
        return ok({ insightsCreated: 0 });
      }

      // 5. Store each insight
      let insightsCreated = 0;
      for (const content of insightLines) {
        const result = await this.store.insertInsight({
          codespaceId,
          content,
          source: 'agent_derived',
          sourceSessionId: memorySessionId,
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

      log.info('Derived insights from session', {
        data: {
          memorySessionId,
          codespaceId,
          insightsCreated,
          totalExtracted: insightLines.length,
        },
      });

      return ok({ insightsCreated });
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
}
