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

export type MemoryTab = 'overview' | 'insights' | 'skills' | 'dream';

export type SuggestionFilter = SkillSuggestion['status'] | 'all';
