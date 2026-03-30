/**
 * Internal memory service types.
 * Internal memory service types backed by local SQLite storage.
 */

/**
 * Reference to an internal memory session, used to track message capture context.
 */
export interface MemorySessionRef {
  memorySessionId: string;
  codespaceId: string;
  agentId: string;
  taskId: string;
}

/**
 * Assembled memory context for agent prompt injection.
 */
export interface MemoryContext {
  text: string;
  tokenCount: number;
  sources: {
    insights: number;
    insightIds: string[];
  };
}

/**
 * An insight derived from agent sessions or created manually.
 */
export interface Insight {
  id: string;
  codespaceId: string;
  content: string;
  source: 'agent_derived' | 'manual' | 'dream';
  sourceSessionId: string | null;
  skillId: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  status: 'active' | 'pending_review' | 'rejected';
  category: 'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson' | null;
  updatedAt: string | null;
  createdAt: string;
}

/**
 * A captured agent message for memory derivation.
 */
export interface MemoryMessage {
  id: string;
  codespaceId: string;
  memorySessionId: string;
  agentId: string;
  taskId: string | null;
  role: 'user' | 'assistant';
  content: string;
  turnNumber: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * A skill execution record.
 */
export interface SkillExecution {
  id: string;
  codespaceId: string;
  skillId: string;
  skillName: string | null;
  taskId: string | null;
  agentRunId: string | null;
  sessionId: string | null;
  status: 'success' | 'failed' | 'cancelled' | 'turn_limit';
  turnsUsed: number | null;
  tokensUsed: number | null;
  durationMs: number | null;
  filesModified: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  insightIdsUsed: string[] | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * Aggregated skill metrics.
 */
export interface SkillMetrics {
  id: string;
  codespaceId: string;
  skillId: string;
  skillName: string;
  totalRuns: number;
  successCount: number;
  errorCount: number;
  avgTokensUsed: number | null;
  avgTurnsUsed: number | null;
  avgDurationMs: number | null;
  avgCostUsd: number | null;
  successRate: number | null;
  lastRunAt: string | null;
  updatedAt: string;
}

/**
 * A dream session record.
 */
export interface DreamSession {
  id: string;
  codespaceId: string | null;
  type: 'conclusion_derivation' | 'skill_improvement' | 'metrics_rollup';
  status: 'running' | 'completed' | 'error';
  skillsAnalyzed: number;
  suggestionsGenerated: number;
  tokensUsed: number;
  costUsd: number | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/**
 * A skill improvement suggestion from dreaming.
 */
export interface SkillSuggestion {
  id: string;
  dreamSessionId: string;
  codespaceId: string;
  skillId: string;
  skillName: string;
  suggestionType: 'improve_prompt' | 'add_example' | 'fix_pattern' | 'new_skill';
  title: string;
  reasoning: string;
  currentContent: string | null;
  suggestedContent: string;
  diff: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'modified';
  userNotes: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  createdAt: string;
}

/**
 * Search result from memory query.
 */
export interface SearchResult {
  id: string;
  content: string;
  score?: number;
  type: 'insight';
  skillId: string | null;
  createdAt: string;
}

/**
 * Memory service health status.
 */
export interface HealthStatus {
  available: boolean;
  insightCount: number;
  messageCount: number;
}

/**
 * Pagination options for list endpoints.
 */
export interface PaginationOptions {
  page?: number;
  size?: number;
}

/**
 * Empty memory context returned when memory is unavailable.
 */
export const EMPTY_CONTEXT: MemoryContext = {
  text: '',
  tokenCount: 0,
  sources: { insights: 0, insightIds: [] },
};
