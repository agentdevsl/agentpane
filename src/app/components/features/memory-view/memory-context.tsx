import type React from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { toast } from '@/app/components/ui/toast';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import type {
  DreamSession,
  HealthStatus,
  Insight,
  MemoryTab,
  SearchResult,
  SkillExecution,
  SkillMetrics,
  SkillSuggestion,
  SuggestionFilter,
} from './types';

// =============================================================================
// Types
// =============================================================================

interface MemoryContextValue {
  // Codespace
  codespaceId: string | null;

  // Tab
  activeTab: MemoryTab;
  setActiveTab: (tab: MemoryTab) => void;

  // Health
  health: HealthStatus | null;
  healthLoading: boolean;

  // Insights
  insights: Array<Insight>;
  insightsLoading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: Array<SearchResult> | null;
  isSearching: boolean;
  refreshInsights: () => Promise<void>;
  createInsight: (data: {
    content: string;
    source?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<boolean>;
  deleteInsight: (id: string) => Promise<boolean>;

  // Skills
  skillMetrics: Array<SkillMetrics>;
  skillMetricsLoading: boolean;
  expandedSkillId: string | null;
  setExpandedSkillId: (id: string | null) => void;
  skillExecutions: Map<string, Array<SkillExecution>>;
  loadExecutions: (skillId: string) => Promise<void>;
  refreshSkillMetrics: () => Promise<void>;

  // Dream
  dreamSessions: Array<DreamSession>;
  dreamSessionsLoading: boolean;
  isDreamRunning: boolean;
  triggerDream: () => Promise<boolean>;
  suggestions: Array<SkillSuggestion>;
  suggestionsLoading: boolean;
  suggestionFilter: SuggestionFilter;
  setSuggestionFilter: (f: SuggestionFilter) => void;
  acceptSuggestion: (id: string, notes?: string) => Promise<boolean>;
  rejectSuggestion: (id: string, notes?: string) => Promise<boolean>;
  modifySuggestion: (id: string, content: string, notes?: string) => Promise<boolean>;
  refreshSuggestions: () => Promise<void>;
}

interface MemoryProviderProps {
  codespaceId: string | null;
  children: React.ReactNode;
}

// =============================================================================
// Context
// =============================================================================

const MemoryContext = createContext<MemoryContextValue | null>(null);

export function useMemory(): MemoryContextValue {
  const ctx = useContext(MemoryContext);
  if (!ctx) {
    throw new Error('useMemory must be used within a MemoryProvider');
  }
  return ctx;
}

// =============================================================================
// Provider
// =============================================================================

const SEARCH_DEBOUNCE_MS = 300;

export function MemoryProvider({ codespaceId, children }: MemoryProviderProps): React.JSX.Element {
  // Tab
  const [activeTab, setActiveTab] = useState<MemoryTab>('overview');

  // Health
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  // Insights
  const [insights, setInsights] = useState<Array<Insight>>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<SearchResult> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);

  // Skills
  const [skillMetrics, setSkillMetrics] = useState<Array<SkillMetrics>>([]);
  const [skillMetricsLoading, setSkillMetricsLoading] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [skillExecutions, setSkillExecutions] = useState(
    () => new Map<string, Array<SkillExecution>>()
  );
  const skillsLoadedRef = useRef(false);
  const skillExecutionsCacheRef = useRef<Set<string>>(new Set());

  // Dream
  const [dreamSessions, setDreamSessions] = useState<Array<DreamSession>>([]);
  const [dreamSessionsLoading, setDreamSessionsLoading] = useState(false);
  const [isDreamRunning, setIsDreamRunning] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<SkillSuggestion>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionFilter, setSuggestionFilter] = useState<SuggestionFilter>('all');
  const dreamLoadedRef = useRef(false);
  const dreamFilterInitialRef = useRef(false);

  // Track current codespace to guard against stale responses
  const currentCodespaceRef = useRef<string | null>(codespaceId);
  currentCodespaceRef.current = codespaceId;

  // ---------------------------------------------------------------------------
  // Data fetchers (with error handling)
  // ---------------------------------------------------------------------------

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    const result = await apiClient.memory.health();
    if (result.ok) {
      setHealth(result.data);
    } else {
      toast.error(result.error?.message ?? 'Failed to check memory health');
    }
    setHealthLoading(false);
  }, []);

  const fetchInsights = useCallback(async (csId: string) => {
    setInsightsLoading(true);
    const result = await apiClient.memory.getInsights(csId);
    if (currentCodespaceRef.current !== csId) return;
    if (result.ok) {
      setInsights(result.data);
    } else {
      toast.error(result.error?.message ?? 'Failed to load insights');
    }
    setInsightsLoading(false);
  }, []);

  const fetchSkillMetrics = useCallback(async (csId: string) => {
    setSkillMetricsLoading(true);
    const result = await apiClient.memory.getSkillMetrics(csId);
    if (currentCodespaceRef.current !== csId) return;
    if (result.ok) {
      setSkillMetrics(result.data);
    } else {
      toast.error(result.error?.message ?? 'Failed to load skill metrics');
    }
    setSkillMetricsLoading(false);
  }, []);

  const fetchDreamSessions = useCallback(async (csId: string) => {
    setDreamSessionsLoading(true);
    const result = await apiClient.memory.getDreamSessions(csId);
    if (currentCodespaceRef.current !== csId) return;
    if (result.ok) {
      const data = result.data;
      setDreamSessions(data);
      const running = data.some((s) => s.status === 'running');
      setIsDreamRunning(running);
    } else {
      toast.error(result.error?.message ?? 'Failed to load dream sessions');
    }
    setDreamSessionsLoading(false);
  }, []);

  const fetchSuggestions = useCallback(
    async (csId: string) => {
      setSuggestionsLoading(true);
      const params = suggestionFilter === 'all' ? undefined : { status: suggestionFilter };
      const result = await apiClient.memory.getSuggestions(csId, params);
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setSuggestions(result.data);
      } else {
        toast.error(result.error?.message ?? 'Failed to load suggestions');
      }
      setSuggestionsLoading(false);
    },
    [suggestionFilter]
  );

  // ---------------------------------------------------------------------------
  // Fetch health + insights when codespaceId changes
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    // Reset all state on codespace change
    setHealth(null);
    setInsights([]);
    setSearchQuery('');
    setSearchResults(null);
    setSkillMetrics([]);
    setExpandedSkillId(null);
    setSkillExecutions(new Map());
    setDreamSessions([]);
    setIsDreamRunning(false);
    setSuggestions([]);
    setSuggestionFilter('all');
    skillsLoadedRef.current = false;
    skillExecutionsCacheRef.current = new Set();
    dreamLoadedRef.current = false;
    dreamFilterInitialRef.current = false;

    if (!codespaceId) return;

    void fetchHealth();
    void fetchInsights(codespaceId);
  }, [codespaceId, fetchHealth, fetchInsights]);

  // ---------------------------------------------------------------------------
  // Lazy-load skills tab data
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (activeTab !== 'skills' || skillsLoadedRef.current || !codespaceId) return;
    skillsLoadedRef.current = true;
    void fetchSkillMetrics(codespaceId);
  }, [activeTab, codespaceId, fetchSkillMetrics]);

  // ---------------------------------------------------------------------------
  // Lazy-load dream tab data
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (activeTab !== 'dream' || dreamLoadedRef.current || !codespaceId) return;
    dreamLoadedRef.current = true;
    void fetchDreamSessions(codespaceId);
    void fetchSuggestions(codespaceId);
  }, [activeTab, codespaceId, fetchDreamSessions, fetchSuggestions]);

  // ---------------------------------------------------------------------------
  // Re-fetch suggestions when filter changes (skip initial load)
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (!dreamLoadedRef.current || !codespaceId) return;
    if (!dreamFilterInitialRef.current) {
      dreamFilterInitialRef.current = true;
      return;
    }
    void fetchSuggestions(codespaceId);
  }, [suggestionFilter, codespaceId, fetchSuggestions]);

  // ---------------------------------------------------------------------------
  // Debounced search (with race condition protection)
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }

    if (!searchQuery.trim()) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    if (!codespaceId) return;

    setIsSearching(true);
    const csId = codespaceId;
    const requestId = ++searchRequestIdRef.current;

    searchTimeoutRef.current = setTimeout(async () => {
      const result = await apiClient.memory.search(csId, searchQuery.trim());
      // Only apply results if this is still the latest request
      if (requestId !== searchRequestIdRef.current) return;
      if (result.ok) {
        setSearchResults(result.data);
      } else {
        setSearchResults(null);
        toast.error(result.error?.message ?? 'Search failed');
      }
      setIsSearching(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
    };
  }, [searchQuery, codespaceId]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const refreshInsights = useCallback(async () => {
    if (!codespaceId) return;
    await fetchInsights(codespaceId);
  }, [codespaceId, fetchInsights]);

  const createInsight = useCallback(
    async (data: {
      content: string;
      source?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    }): Promise<boolean> => {
      if (!codespaceId) return false;

      const result = await apiClient.memory.createInsight(codespaceId, data);
      if (result.ok) {
        toast.success('Insight created');
        await fetchInsights(codespaceId);
        return true;
      }
      toast.error(result.error?.message ?? 'Failed to create insight');
      return false;
    },
    [codespaceId, fetchInsights]
  );

  const deleteInsight = useCallback(
    async (id: string): Promise<boolean> => {
      if (!codespaceId) return false;

      const result = await apiClient.memory.deleteInsight(id);
      if (result.ok) {
        toast.success('Insight deleted');
        await fetchInsights(codespaceId);
        return true;
      }
      toast.error(result.error?.message ?? 'Failed to delete insight');
      return false;
    },
    [codespaceId, fetchInsights]
  );

  const loadExecutions = useCallback(
    async (skillId: string) => {
      if (!codespaceId) return;

      // Use ref-based cache to avoid stale closure issues
      if (skillExecutionsCacheRef.current.has(skillId)) return;
      skillExecutionsCacheRef.current.add(skillId);

      const result = await apiClient.memory.getSkillExecutions(codespaceId, skillId);
      if (result.ok) {
        setSkillExecutions((prev: Map<string, Array<SkillExecution>>) => {
          const next = new Map(prev);
          next.set(skillId, result.data);
          return next;
        });
      } else {
        // Remove from cache so retry is possible
        skillExecutionsCacheRef.current.delete(skillId);
        toast.error(result.error?.message ?? 'Failed to load executions');
      }
    },
    [codespaceId]
  );

  const refreshSkillMetrics = useCallback(async () => {
    if (!codespaceId) return;
    setSkillExecutions(new Map());
    skillExecutionsCacheRef.current = new Set();
    await fetchSkillMetrics(codespaceId);
  }, [codespaceId, fetchSkillMetrics]);

  const triggerDream = useCallback(async (): Promise<boolean> => {
    if (!codespaceId) return false;

    setIsDreamRunning(true);
    const result = await apiClient.memory.triggerDream(codespaceId);
    if (result.ok) {
      toast.success('Dream session started');
      await fetchDreamSessions(codespaceId);
      return true;
    }
    setIsDreamRunning(false);
    toast.error(result.error?.message ?? 'Failed to start dream session');
    return false;
  }, [codespaceId, fetchDreamSessions]);

  const refreshSuggestions = useCallback(async () => {
    if (!codespaceId) return;
    await fetchSuggestions(codespaceId);
  }, [codespaceId, fetchSuggestions]);

  const acceptSuggestion = useCallback(
    async (id: string, notes?: string): Promise<boolean> => {
      const result = await apiClient.memory.acceptSuggestion(id, notes);
      if (result.ok) {
        toast.success('Suggestion accepted');
        if (codespaceId) await fetchSuggestions(codespaceId);
        return true;
      }
      toast.error(result.error?.message ?? 'Failed to accept suggestion');
      return false;
    },
    [codespaceId, fetchSuggestions]
  );

  const rejectSuggestion = useCallback(
    async (id: string, notes?: string): Promise<boolean> => {
      const result = await apiClient.memory.rejectSuggestion(id, notes);
      if (result.ok) {
        toast.success('Suggestion rejected');
        if (codespaceId) await fetchSuggestions(codespaceId);
        return true;
      }
      toast.error(result.error?.message ?? 'Failed to reject suggestion');
      return false;
    },
    [codespaceId, fetchSuggestions]
  );

  const modifySuggestion = useCallback(
    async (id: string, content: string, notes?: string): Promise<boolean> => {
      const result = await apiClient.memory.modifySuggestion(id, content, notes);
      if (result.ok) {
        toast.success('Suggestion modified');
        if (codespaceId) await fetchSuggestions(codespaceId);
        return true;
      }
      toast.error(result.error?.message ?? 'Failed to modify suggestion');
      return false;
    },
    [codespaceId, fetchSuggestions]
  );

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const contextValue = useMemo<MemoryContextValue>(
    () => ({
      codespaceId,
      activeTab,
      setActiveTab,
      health,
      healthLoading,
      insights,
      insightsLoading,
      searchQuery,
      setSearchQuery,
      searchResults,
      isSearching,
      refreshInsights,
      createInsight,
      deleteInsight,
      skillMetrics,
      skillMetricsLoading,
      expandedSkillId,
      setExpandedSkillId,
      skillExecutions,
      loadExecutions,
      refreshSkillMetrics,
      dreamSessions,
      dreamSessionsLoading,
      isDreamRunning,
      triggerDream,
      suggestions,
      suggestionsLoading,
      suggestionFilter,
      setSuggestionFilter,
      acceptSuggestion,
      rejectSuggestion,
      modifySuggestion,
      refreshSuggestions,
    }),
    [
      codespaceId,
      activeTab,
      health,
      healthLoading,
      insights,
      insightsLoading,
      searchQuery,
      searchResults,
      isSearching,
      refreshInsights,
      createInsight,
      deleteInsight,
      skillMetrics,
      skillMetricsLoading,
      expandedSkillId,
      skillExecutions,
      loadExecutions,
      refreshSkillMetrics,
      dreamSessions,
      dreamSessionsLoading,
      isDreamRunning,
      triggerDream,
      suggestions,
      suggestionsLoading,
      suggestionFilter,
      acceptSuggestion,
      rejectSuggestion,
      modifySuggestion,
      refreshSuggestions,
    ]
  );

  return <MemoryContext.Provider value={contextValue}>{children}</MemoryContext.Provider>;
}
