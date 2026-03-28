export type {
  DreamSession,
  HealthStatus,
  Insight,
  SearchResult,
  SkillExecution,
  SkillMetrics,
  SkillSuggestion,
} from '@/services/memory/types';

import type { SkillSuggestion } from '@/services/memory/types';

export interface SyncedSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  sourceType: string;
  sourceName: string;
}

export interface SkillDreamOverride {
  enabled?: boolean;
  model?: string;
  minRuns?: number;
}

export interface InsightInjection {
  sessionId: string;
  agentId: string;
  taskId: string | null;
  taskTitle: string | null;
  codespaceId: string | null;
  codespaceName: string | null;
  insightCount: number;
  tokenCount: number;
  timestamp: number;
}

export type MemoryTab = 'overview' | 'insights' | 'skills' | 'dream';

export type SuggestionFilter = SkillSuggestion['status'] | 'all';
