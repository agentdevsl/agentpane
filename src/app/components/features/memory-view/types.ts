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

export type MemoryTab = 'overview' | 'insights' | 'skills' | 'dream';

export type SuggestionFilter = SkillSuggestion['status'] | 'all';
