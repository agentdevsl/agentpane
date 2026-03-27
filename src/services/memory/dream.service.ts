/**
 * DreamService — Core dreaming engine for scheduled skill improvement.
 *
 * Analyzes historical run data using Claude to generate skill improvement suggestions.
 * Suggestions are stored as pending for human review (accept/reject/modify).
 *
 * Dream cycle:
 * 1. Iterate all skills, applying per-skill config overrides (enabled, model, minRuns)
 * 2. Skip disabled skills and those with fewer runs than their minRuns threshold
 * 3. For each eligible skill, gather performance summary + recent executions
 * 4. Send to Claude for analysis using the skill's configured model
 * 5. Store suggestions in skill_suggestions table as 'pending'
 */

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, or } from 'drizzle-orm';
import { agentPrompt } from '../../lib/agents/agent-sdk-utils.js';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { SettingsService } from '../settings.service.js';
import type { SkillTrackingService } from './skill-tracking.service.js';
import type { DreamSession, PaginationOptions, SkillSuggestion } from './types.js';

const log = createLogger('DreamService');

/** Default model for dreaming — cost-efficient */
const DEFAULT_DREAM_MODEL = 'claude-haiku-4-5-20251001';

/** Default max tokens per dream cycle */
const DEFAULT_MAX_TOKENS_PER_CYCLE = 50000;

/** Default minimum runs before a skill is analyzed */
const DEFAULT_MIN_RUNS = 3;

const DREAM_ANALYZE_SKILL_PROMPT = `You are analyzing the execution history of a Claude Code skill to suggest improvements.

## Skill Information
**Skill ID:** {{skillId}}
**Skill Name:** {{skillName}}

## Current Skill Content
{{skillContent}}

## Performance Summary
- Total runs: {{totalRuns}}
- Success rate: {{successRate}}%
- Average tokens used: {{avgTokens}}
- Average turns used: {{avgTurns}}
- Average duration: {{avgDuration}}ms
- Error count: {{errorCount}}

## Common Error Patterns
{{errorPatterns}}

## Recent Successful Executions
{{successExamples}}

## Recent Failed Executions
{{failedExamples}}

## Instructions

Analyze this skill's execution history and suggest concrete improvements. For each suggestion, provide:
1. A short title (what to improve)
2. The type: "improve_prompt" | "add_example" | "fix_pattern" | "new_skill"
3. Your reasoning based on the data above
4. The suggested new/modified content for the skill

Return your suggestions as a JSON array:
\`\`\`json
[
  {
    "type": "improve_prompt",
    "title": "Short title of the improvement",
    "reasoning": "Why this improvement is suggested based on the execution data",
    "suggestedContent": "The complete new skill content"
  }
]
\`\`\`

Focus on:
- Reducing failure rate by addressing common error patterns
- Reducing token usage by making instructions clearer
- Adding examples from successful runs
- Fixing patterns that lead to errors

If the skill is performing well (>90% success rate, reasonable token usage), you may return an empty array \`[]\`.
Only return the JSON array, no additional text.`;

interface ParsedSuggestion {
  type: 'improve_prompt' | 'add_example' | 'fix_pattern' | 'new_skill';
  title: string;
  reasoning: string;
  suggestedContent: string;
}

export class DreamService {
  constructor(
    private db: Database,
    private settingsService: SettingsService,
    private skillTrackingService: SkillTrackingService
  ) {}

  private async getModel(): Promise<string> {
    const result = await this.settingsService.get('memory.dreaming.model');
    if (result.ok && result.value) {
      return (result.value.value as string) ?? DEFAULT_DREAM_MODEL;
    }
    return DEFAULT_DREAM_MODEL;
  }

  private async getMinRuns(): Promise<number> {
    const minRunsResult = await this.settingsService.get('memory.dreaming.minRunsForAnalysis');
    if (minRunsResult.ok && minRunsResult.value) {
      try {
        const parsed = JSON.parse(minRunsResult.value.value);
        if (typeof parsed === 'number') return parsed;
      } catch {
        log.warn('Invalid memory.dreaming.minRunsForAnalysis setting, using default', {
          data: { rawValue: minRunsResult.value.value },
        });
      }
    }
    return DEFAULT_MIN_RUNS;
  }

  /**
   * Get all per-skill dream config overrides.
   * Returns an empty object if none are set or on error.
   */
  async getSkillOverrides(): Promise<
    Record<string, { enabled?: boolean; model?: string; minRuns?: number }>
  > {
    const result = await this.settingsService.get('memory.dreaming.skillOverrides');
    if (result.ok && result.value) {
      try {
        const parsed = JSON.parse(result.value.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, { enabled?: boolean; model?: string; minRuns?: number }>;
        }
      } catch {
        // return empty on parse error
      }
    }
    return {};
  }

  /**
   * Set or clear a per-skill dream config override.
   * Pass null to remove the override for that skill.
   */
  async setSkillOverride(
    skillId: string,
    override: { enabled?: boolean; model?: string; minRuns?: number } | null
  ): Promise<Result<void, MemoryError>> {
    try {
      const current = await this.getSkillOverrides();

      if (override === null) {
        delete current[skillId];
      } else {
        current[skillId] = override;
      }

      const setResult = await this.settingsService.set(
        'memory.dreaming.skillOverrides',
        JSON.stringify(current)
      );
      if (!setResult.ok) {
        return err(MemoryErrors.QUERY_ERROR('Failed to save skill override'));
      }

      return ok(undefined);
    } catch (error) {
      log.error('Failed to set skill override', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { skillId },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to set skill override'));
    }
  }

  /**
   * Get the effective dream config for a specific skill by merging global
   * defaults with any per-skill overrides.
   */
  async getSkillConfig(
    skillId: string
  ): Promise<{ enabled: boolean; model: string; minRuns: number }> {
    const [globalModel, globalMinRuns, overrides] = await Promise.all([
      this.getModel(),
      this.getMinRuns(),
      this.getSkillOverrides(),
    ]);

    const skillOverride = overrides[skillId];

    return {
      enabled: skillOverride?.enabled ?? true,
      model: skillOverride?.model ?? globalModel,
      minRuns: skillOverride?.minRuns ?? globalMinRuns,
    };
  }

  /**
   * Run a full dream cycle. When codespaceId is provided, analyzes eligible
   * skills in that codespace; otherwise analyzes all skills globally.
   * Per-skill config overrides (enabled, model, minRuns) are applied for each skill.
   */
  async runDreamCycle(codespaceId?: string): Promise<Result<DreamSession, MemoryError>> {
    const startedAt = new Date().toISOString();
    const dreamId = createId();

    try {
      const { dreamSessions, skillMetrics } = await import('../../db/schema/index.js');

      // Create dream session record
      await this.db.insert(dreamSessions).values({
        id: dreamId,
        codespaceId: codespaceId ?? null,
        type: 'skill_improvement',
        status: 'running',
        skillsAnalyzed: 0,
        suggestionsGenerated: 0,
        tokensUsed: 0,
        startedAt,
        createdAt: startedAt,
      });

      // Find eligible skills
      const conditions = [];
      if (codespaceId) {
        conditions.push(eq(skillMetrics.codespaceId, codespaceId));
      }

      const allMetrics = await this.db.query.skillMetrics?.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(skillMetrics.lastRunAt)],
      });

      let totalTokensUsed = 0;
      let totalSuggestions = 0;
      let skillsAnalyzedCount = 0;
      const maxTokens = await this.getMaxTokensPerCycle();

      for (const skill of allMetrics ?? []) {
        if (totalTokensUsed >= maxTokens) {
          log.info('Dream cycle token budget exhausted', {
            data: { tokensUsed: totalTokensUsed, maxTokens },
          });
          break;
        }

        // Get per-skill config (merges global defaults with overrides)
        const skillConfig = await this.getSkillConfig(skill.skillId);

        // Skip disabled skills
        if (!skillConfig.enabled) {
          log.debug('Skipping disabled skill', { data: { skillId: skill.skillId } });
          continue;
        }

        // Skip skills without enough runs
        if (Number(skill.totalRuns) < skillConfig.minRuns) {
          continue;
        }

        try {
          const result = await this.analyzeSkill(
            dreamId,
            skill.codespaceId,
            skill.skillId,
            skill.skillName,
            skillConfig.model
          );

          if (result.ok) {
            totalTokensUsed += result.value.tokensUsed;
            totalSuggestions += result.value.suggestionsCreated;
          }
          skillsAnalyzedCount++;
        } catch (skillError) {
          log.warn('Failed to analyze skill', {
            data: { skillId: skill.skillId },
            error: skillError instanceof Error ? skillError : new Error(String(skillError)),
          });
        }
      }

      // Update dream session
      const completedAt = new Date().toISOString();
      await this.db
        .update(dreamSessions)
        .set({
          status: 'completed',
          skillsAnalyzed: skillsAnalyzedCount,
          suggestionsGenerated: totalSuggestions,
          tokensUsed: totalTokensUsed,
          completedAt,
        })
        .where(eq(dreamSessions.id, dreamId));

      const session: DreamSession = {
        id: dreamId,
        codespaceId: codespaceId ?? null,
        type: 'skill_improvement',
        status: 'completed',
        skillsAnalyzed: skillsAnalyzedCount,
        suggestionsGenerated: totalSuggestions,
        tokensUsed: totalTokensUsed,
        costUsd: null,
        startedAt,
        completedAt,
        errorMessage: null,
        createdAt: startedAt,
      };

      log.info('Dream cycle completed', {
        data: {
          dreamId,
          skillsAnalyzed: skillsAnalyzedCount,
          suggestionsGenerated: totalSuggestions,
          tokensUsed: totalTokensUsed,
        },
      });

      return ok(session);
    } catch (error) {
      log.error('Dream cycle failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });

      try {
        const { dreamSessions } = await import('../../db/schema/index.js');
        await this.db
          .update(dreamSessions)
          .set({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString(),
          })
          .where(eq(dreamSessions.id, dreamId));
      } catch (updateError) {
        log.error('Failed to update dream session status to error', {
          error: updateError instanceof Error ? updateError : new Error(String(updateError)),
          data: {
            dreamId,
            originalError: error instanceof Error ? error.message : String(error),
          },
        });
      }

      return err(MemoryErrors.DERIVATION_ERROR('Dream cycle failed'));
    }
  }

  /**
   * Load skill content from cached templates for a given codespace.
   */
  private async loadSkillContent(codespaceId: string, skillId: string): Promise<string> {
    try {
      const { templates } = await import('../../db/schema/index.js');

      const allTemplates = await this.db.query.templates.findMany({
        where: and(
          or(eq(templates.codespaceId, codespaceId), eq(templates.scope, 'org')),
          eq(templates.status, 'active')
        ),
      });

      for (const tpl of allTemplates) {
        const skills = (tpl.cachedSkills ?? []) as Array<{ id: string; content: string }>;
        const match = skills.find((s) => s.id === skillId);
        if (match?.content) return match.content;
      }
    } catch (loadError) {
      log.warn('Failed to load skill content', {
        data: { codespaceId, skillId },
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
      });
    }
    return '[Skill content not available]';
  }

  /**
   * Analyze a single skill and generate improvement suggestions.
   */
  private async analyzeSkill(
    dreamSessionId: string,
    codespaceId: string,
    skillId: string,
    skillName: string,
    model?: string
  ): Promise<Result<{ suggestionsCreated: number; tokensUsed: number }, MemoryError>> {
    try {
      // Get performance summary
      const summaryResult = await this.skillTrackingService.getSkillPerformanceSummary(
        codespaceId,
        skillId
      );
      if (!summaryResult.ok) return summaryResult;

      const { metrics, recentExecutions, errorPatterns } = summaryResult.value;
      if (!metrics) {
        return ok({ suggestionsCreated: 0, tokensUsed: 0 });
      }

      // Build the analysis prompt
      const successExamples =
        recentExecutions
          .filter((e) => e.status === 'success')
          .slice(0, 3)
          .map(
            (e) =>
              `- Task: ${e.taskId || 'unknown'}, Turns: ${e.turnsUsed}, Tokens: ${e.tokensUsed}, Duration: ${e.durationMs}ms`
          )
          .join('\n') || 'No successful executions available';

      const failedExamples =
        recentExecutions
          .filter((e) => e.status === 'failed')
          .slice(0, 3)
          .map(
            (e) =>
              `- Task: ${e.taskId || 'unknown'}, Error: ${e.errorMessage || 'Unknown'}, Turns: ${e.turnsUsed}`
          )
          .join('\n') || 'No failed executions';

      const errorPatternsText =
        errorPatterns.map((e) => `- "${e.message}" (occurred ${e.count} times)`).join('\n') ||
        'No recurring error patterns';

      const skillContent = await this.loadSkillContent(codespaceId, skillId);

      const prompt = DREAM_ANALYZE_SKILL_PROMPT.replace('{{skillId}}', skillId)
        .replace('{{skillName}}', skillName)
        .replace('{{skillContent}}', skillContent)
        .replace('{{totalRuns}}', String(metrics.totalRuns))
        .replace(
          '{{successRate}}',
          metrics.successRate != null ? (metrics.successRate * 100).toFixed(1) : 'N/A'
        )
        .replace('{{avgTokens}}', String(Math.round(metrics.avgTokensUsed ?? 0)))
        .replace('{{avgTurns}}', String(Math.round(metrics.avgTurnsUsed ?? 0)))
        .replace('{{avgDuration}}', String(Math.round(metrics.avgDurationMs ?? 0)))
        .replace('{{errorCount}}', String(metrics.errorCount))
        .replace('{{errorPatterns}}', errorPatternsText)
        .replace('{{successExamples}}', successExamples)
        .replace('{{failedExamples}}', failedExamples);

      const effectiveModel = model ?? (await this.getModel());

      const response = await agentPrompt(prompt, { model: effectiveModel });

      const tokensUsed = (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);

      // Parse suggestions from response
      const responseText = response.text;

      const suggestions = this.parseSuggestions(responseText);

      // Store suggestions
      const { skillSuggestions } = await import('../../db/schema/index.js');
      const now = new Date().toISOString();

      for (const suggestion of suggestions) {
        await this.db.insert(skillSuggestions).values({
          id: createId(),
          dreamSessionId,
          codespaceId,
          skillId,
          skillName,
          suggestionType: suggestion.type,
          title: suggestion.title,
          reasoning: suggestion.reasoning,
          currentContent: null,
          suggestedContent: suggestion.suggestedContent,
          diff: null,
          status: 'pending',
          createdAt: now,
        });
      }

      log.debug('Analyzed skill', {
        data: { skillId, suggestionsCreated: suggestions.length, tokensUsed },
      });

      return ok({ suggestionsCreated: suggestions.length, tokensUsed });
    } catch (error) {
      log.error('Failed to analyze skill', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.DERIVATION_ERROR(`Failed to analyze skill: ${skillId}`));
    }
  }

  /**
   * Parse suggestions from Claude's response.
   */
  private parseSuggestions(text: string): ParsedSuggestion[] {
    try {
      // Extract JSON from response (may be wrapped in ```json ... ```)
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const jsonStr = jsonMatch[1] ?? jsonMatch[0];
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) return [];

      const validTypes = new Set(['improve_prompt', 'add_example', 'fix_pattern', 'new_skill']);

      return parsed
        .filter(
          (s: unknown): s is ParsedSuggestion =>
            typeof s === 'object' &&
            s !== null &&
            'type' in s &&
            'title' in s &&
            'reasoning' in s &&
            'suggestedContent' in s &&
            validTypes.has((s as Record<string, unknown>).type as string)
        )
        .map((s) => ({
          type: s.type,
          title: String(s.title).slice(0, 200),
          reasoning: String(s.reasoning),
          suggestedContent: String(s.suggestedContent),
        }));
    } catch (parseError) {
      log.warn('Failed to parse dream suggestions from Claude response', {
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
        data: { textLength: text.length, textPreview: text.slice(0, 200) },
      });
      return [];
    }
  }

  // --- Admin / Query Methods ---

  /**
   * List dream sessions.
   */
  async getDreamSessions(
    codespaceId: string | null,
    options?: PaginationOptions
  ): Promise<Result<DreamSession[], MemoryError>> {
    try {
      const { dreamSessions } = await import('../../db/schema/index.js');

      const page = options?.page ?? 1;
      const size = options?.size ?? 20;
      const offset = (page - 1) * size;

      const conditions = codespaceId ? [eq(dreamSessions.codespaceId, codespaceId)] : [];

      const results = await this.db
        .select()
        .from(dreamSessions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(dreamSessions.createdAt))
        .limit(size)
        .offset(offset);

      return ok(results as DreamSession[]);
    } catch (error) {
      log.error('Failed to list dream sessions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to list dream sessions'));
    }
  }

  /**
   * List skill suggestions with optional filtering.
   */
  async getSkillSuggestions(
    codespaceId: string | null,
    filters?: { status?: 'pending' | 'accepted' | 'rejected' | 'modified'; skillId?: string },
    options?: PaginationOptions
  ): Promise<Result<SkillSuggestion[], MemoryError>> {
    try {
      const { skillSuggestions } = await import('../../db/schema/index.js');

      const page = options?.page ?? 1;
      const size = options?.size ?? 20;
      const offset = (page - 1) * size;

      const conditions: ReturnType<typeof eq>[] = [];
      if (codespaceId) {
        conditions.push(eq(skillSuggestions.codespaceId, codespaceId));
      }
      if (filters?.status) {
        conditions.push(eq(skillSuggestions.status, filters.status));
      }
      if (filters?.skillId) {
        conditions.push(eq(skillSuggestions.skillId, filters.skillId));
      }

      const results = await this.db
        .select()
        .from(skillSuggestions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(skillSuggestions.createdAt))
        .limit(size)
        .offset(offset);

      return ok(results as SkillSuggestion[]);
    } catch (error) {
      log.error('Failed to list skill suggestions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to list skill suggestions'));
    }
  }

  /**
   * Accept a suggestion — marks it as accepted and records when/who.
   * The actual skill file update is handled by the caller (route handler).
   */
  async acceptSuggestion(
    suggestionId: string,
    userNotes?: string
  ): Promise<Result<SkillSuggestion, MemoryError>> {
    try {
      const { skillSuggestions } = await import('../../db/schema/index.js');

      const existing = await this.db.query.skillSuggestions?.findFirst({
        where: eq(skillSuggestions.id, suggestionId),
      });

      if (!existing) {
        return err(MemoryErrors.NOT_FOUND(`Suggestion ${suggestionId}`));
      }

      const now = new Date().toISOString();
      await this.db
        .update(skillSuggestions)
        .set({
          status: 'accepted',
          userNotes: userNotes ?? null,
          appliedAt: now,
        })
        .where(eq(skillSuggestions.id, suggestionId));

      return ok({
        ...existing,
        status: 'accepted',
        userNotes: userNotes ?? null,
        appliedAt: now,
      } as SkillSuggestion);
    } catch (error) {
      log.error('Failed to accept suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to accept suggestion'));
    }
  }

  /**
   * Reject a suggestion.
   */
  async rejectSuggestion(
    suggestionId: string,
    userNotes?: string
  ): Promise<Result<SkillSuggestion, MemoryError>> {
    try {
      const { skillSuggestions } = await import('../../db/schema/index.js');

      const existing = await this.db.query.skillSuggestions?.findFirst({
        where: eq(skillSuggestions.id, suggestionId),
      });

      if (!existing) {
        return err(MemoryErrors.NOT_FOUND(`Suggestion ${suggestionId}`));
      }

      await this.db
        .update(skillSuggestions)
        .set({
          status: 'rejected',
          userNotes: userNotes ?? null,
        })
        .where(eq(skillSuggestions.id, suggestionId));

      return ok({
        ...existing,
        status: 'rejected',
        userNotes: userNotes ?? null,
      } as SkillSuggestion);
    } catch (error) {
      log.error('Failed to reject suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to reject suggestion'));
    }
  }

  /**
   * Modify and accept a suggestion with user-edited content.
   */
  async modifySuggestion(
    suggestionId: string,
    modifiedContent: string,
    userNotes?: string
  ): Promise<Result<SkillSuggestion, MemoryError>> {
    try {
      const { skillSuggestions } = await import('../../db/schema/index.js');

      const existing = await this.db.query.skillSuggestions?.findFirst({
        where: eq(skillSuggestions.id, suggestionId),
      });

      if (!existing) {
        return err(MemoryErrors.NOT_FOUND(`Suggestion ${suggestionId}`));
      }

      const now = new Date().toISOString();
      await this.db
        .update(skillSuggestions)
        .set({
          status: 'modified',
          suggestedContent: modifiedContent,
          userNotes: userNotes ?? null,
          appliedAt: now,
        })
        .where(eq(skillSuggestions.id, suggestionId));

      return ok({
        ...existing,
        status: 'modified',
        suggestedContent: modifiedContent,
        userNotes: userNotes ?? null,
        appliedAt: now,
      } as SkillSuggestion);
    } catch (error) {
      log.error('Failed to modify suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to modify suggestion'));
    }
  }

  private async getMaxTokensPerCycle(): Promise<number> {
    const result = await this.settingsService.get('memory.dreaming.maxTokensPerCycle');
    if (result.ok && result.value) {
      try {
        const parsed = JSON.parse(result.value.value);
        if (typeof parsed === 'number') return parsed;
      } catch {
        log.warn('Invalid memory.dreaming.maxTokensPerCycle setting, using default', {
          data: { rawValue: result.value.value },
        });
      }
    }
    return DEFAULT_MAX_TOKENS_PER_CYCLE;
  }
}
