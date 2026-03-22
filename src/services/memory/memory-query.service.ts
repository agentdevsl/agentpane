/**
 * MemoryQueryService — Assembles memory context for agent prompt injection.
 *
 * Queries Honcho for relevant conclusions from both the codespace workspace
 * (codebase-specific knowledge) and the platform workspace (cross-project patterns),
 * then formats them as a markdown block suitable for prepending to the agent prompt.
 *
 * Token budget allocation:
 *   Priority 1: Codespace conclusions (~1200 tokens)
 *   Priority 2: Platform conclusions (~800 tokens)
 *
 * Error handling: Individual query failures are logged and skipped — never blocks agent execution.
 */

import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { ok } from '../../lib/utils/result.js';
import type { SettingsService } from '../settings.service.js';
import type { MemoryQueryServiceInterface } from './memory.service.js';
import type { MemoryClientService } from './memory-client.service.js';
import type { MemoryContext } from './types.js';
import { EMPTY_CONTEXT } from './types.js';

const log = createLogger('MemoryQuery');

/** Approximate token count using chars/4 heuristic. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryQueryService implements MemoryQueryServiceInterface {
  constructor(
    private client: MemoryClientService,
    private settingsService: SettingsService
  ) {}

  async assembleContext(params: {
    codespaceId: string;
    agentId: string;
    taskTitle: string;
    taskDescription: string | null;
  }): Promise<Result<MemoryContext, MemoryError>> {
    const query = `${params.taskTitle} ${params.taskDescription ?? ''}`.trim();

    // Read max token budget from settings (default 2000)
    const maxTokens = await this.readMaxTokens();
    const codespaceTokenBudget = Math.floor(maxTokens * 0.6); // ~1200
    const platformTokenBudget = maxTokens - codespaceTokenBudget; // ~800

    let codespaceText = '';
    let codespaceConclusions = 0;
    let platformText = '';
    let platformConclusions = 0;

    // Priority 1: Codespace conclusions
    try {
      const csClient = this.client.getCodespaceClient(params.codespaceId);
      const peerResult = await this.client.ensurePeer(csClient, `agent-${params.agentId}`);
      if (peerResult.ok) {
        const repResult = await this.client.getRepresentation(peerResult.value, {
          searchQuery: query,
          maxConclusions: 20,
        });
        if (repResult.ok && repResult.value) {
          const trimmed = this.trimToTokenBudget(repResult.value, codespaceTokenBudget);
          codespaceText = trimmed;
          // Estimate conclusion count from non-empty lines (rough heuristic)
          codespaceConclusions = trimmed
            .split('\n')
            .filter((line) => line.trim().length > 0).length;
        }
      } else {
        log.warn('Failed to ensure codespace peer for memory context', {
          data: { codespaceId: params.codespaceId, agentId: params.agentId },
        });
      }
    } catch (error) {
      log.warn('Codespace memory query failed, skipping', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId: params.codespaceId },
      });
    }

    // Priority 2: Platform conclusions (skip if codespace text already exhausts budget)
    const usedTokens = estimateTokens(codespaceText);
    if (usedTokens < maxTokens) {
      try {
        const platformClient = this.client.getPlatformClient();
        const peerResult = await this.client.ensurePeer(platformClient, 'system');
        if (peerResult.ok) {
          const repResult = await this.client.getRepresentation(peerResult.value, {
            searchQuery: query,
            maxConclusions: 10,
          });
          if (repResult.ok && repResult.value) {
            const remainingBudget = Math.min(platformTokenBudget, maxTokens - usedTokens);
            const trimmed = this.trimToTokenBudget(repResult.value, remainingBudget);
            platformText = trimmed;
            platformConclusions = trimmed
              .split('\n')
              .filter((line) => line.trim().length > 0).length;
          }
        } else {
          log.warn('Failed to ensure platform peer for memory context');
        }
      } catch (error) {
        log.warn('Platform memory query failed, skipping', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    // If nothing was retrieved, return empty context
    if (!codespaceText && !platformText) {
      return ok(EMPTY_CONTEXT);
    }

    // Format as markdown
    const sections: string[] = ['## Memory Context', ''];
    if (codespaceText) {
      sections.push('### Codebase Knowledge');
      sections.push(codespaceText);
      sections.push('');
    }
    if (platformText) {
      sections.push('### Platform Patterns');
      sections.push(platformText);
      sections.push('');
    }

    const text = sections.join('\n').trim();
    const tokenCount = estimateTokens(text);

    log.info('Memory context assembled', {
      data: {
        codespaceId: params.codespaceId,
        tokenCount,
        codespaceConclusions,
        platformConclusions,
      },
    });

    return ok({
      text,
      tokenCount,
      sources: {
        conclusions: codespaceConclusions,
        platformConclusions,
      },
    });
  }

  /** Read the max token budget from settings. */
  private async readMaxTokens(): Promise<number> {
    try {
      const result = await this.settingsService.get('memory.contextMaxTokens');
      if (result.ok && result.value?.value) {
        const parsed = Number.parseInt(result.value.value, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
    } catch {
      // Use default
    }
    return 2000;
  }

  /** Trim text to fit within a token budget. */
  private trimToTokenBudget(text: string, maxTokens: number): string {
    if (estimateTokens(text) <= maxTokens) {
      return text;
    }
    // Trim by characters (4 chars ~ 1 token)
    const maxChars = maxTokens * 4;
    return text.slice(0, maxChars);
  }
}
