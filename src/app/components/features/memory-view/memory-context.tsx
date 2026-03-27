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
  SyncedSkill,
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
    source?: Insight['source'];
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<boolean>;
  deleteInsight: (id: string) => Promise<boolean>;

  // Skills
  syncedSkills: Array<SyncedSkill>;
  syncedSkillsLoading: boolean;
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

/**
 * Perform an API mutation, show a toast, and refresh a list on success.
 * Centralizes the try/catch + toast + refresh pattern used by all mutation actions.
 */
async function mutateAndRefresh(opts: {
  action: () => Promise<{ ok: boolean; error?: { message?: string } }>;
  successMessage: string;
  errorMessage: string;
  refresh: () => Promise<void>;
}): Promise<boolean> {
  try {
    const result = await opts.action();
    if (result.ok) {
      toast.success(opts.successMessage);
      await opts.refresh();
      return true;
    }
    toast.error(result.error?.message ?? opts.errorMessage);
    return false;
  } catch {
    toast.error(opts.errorMessage);
    return false;
  }
}

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
  const [syncedSkills, setSyncedSkills] = useState<Array<SyncedSkill>>([]);
  const [syncedSkillsLoading, setSyncedSkillsLoading] = useState(false);
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

  // Track current codespace to guard against stale responses
  const currentCodespaceRef = useRef<string | null>(codespaceId);
  currentCodespaceRef.current = codespaceId;

  // ---------------------------------------------------------------------------
  // Data fetchers (with error handling)
  // ---------------------------------------------------------------------------

  const fetchHealth = useCallback(async (csId: string | null) => {
    setHealthLoading(true);
    try {
      const result = await apiClient.memory.health();
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setHealth(result.data);
      } else {
        toast.error(result.error?.message ?? 'Failed to check memory health');
      }
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to check memory health');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setHealthLoading(false);
    }
  }, []);

  const fetchInsights = useCallback(async (csId: string | null) => {
    setInsightsLoading(true);
    try {
      const result = await apiClient.memory.getInsights(csId);
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setInsights(result.data);
      } else {
        toast.error(result.error?.message ?? 'Failed to load insights');
      }
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to load insights');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setInsightsLoading(false);
    }
  }, []);

  const fetchSyncedSkills = useCallback(async (csId: string | null) => {
    setSyncedSkillsLoading(true);
    try {
      let targetId = csId;
      if (!targetId) {
        // Global mode — skills are org-scoped, so fetch from any codespace
        const listResult = await apiClient.codespaces.list();
        if (currentCodespaceRef.current !== csId) return;
        if (!listResult.ok) {
          toast.error('Failed to load synced skills');
          return;
        }
        const codespaces = Array.isArray(listResult.data)
          ? listResult.data
          : ((listResult.data as { items?: Array<{ id: string }> }).items ?? []);
        targetId = codespaces[0]?.id ?? null;
      }
      if (!targetId) {
        setSyncedSkills([]);
        return;
      }
      const result = await apiClient.codespaces.getSkills(targetId);
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setSyncedSkills(result.data);
      } else {
        toast.error('Failed to load synced skills');
      }
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to load synced skills');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setSyncedSkillsLoading(false);
    }
  }, []);

  const fetchSkillMetrics = useCallback(async (csId: string | null) => {
    setSkillMetricsLoading(true);
    try {
      const result = await apiClient.memory.getSkillMetrics(csId);
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setSkillMetrics(result.data);
      } else {
        toast.error(result.error?.message ?? 'Failed to load skill metrics');
      }
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to load skill metrics');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setSkillMetricsLoading(false);
    }
  }, []);

  const fetchDreamSessions = useCallback(async (csId: string | null) => {
    setDreamSessionsLoading(true);
    try {
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
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to load dream sessions');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setDreamSessionsLoading(false);
    }
  }, []);

  const fetchSuggestions = useCallback(async (csId: string | null) => {
    setSuggestionsLoading(true);
    try {
      // Always fetch all suggestions — client-side filtering preserves accurate counts
      const result = await apiClient.memory.getSuggestions(csId);
      if (currentCodespaceRef.current !== csId) return;
      if (result.ok) {
        setSuggestions(result.data);
      } else {
        toast.error(result.error?.message ?? 'Failed to load suggestions');
      }
    } catch {
      if (currentCodespaceRef.current === csId) {
        toast.error('Failed to load suggestions');
      }
    } finally {
      if (currentCodespaceRef.current === csId) setSuggestionsLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch health + insights when codespaceId changes
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    // Reset all state on codespace change
    setHealth(null);
    setInsights([]);
    setSearchQuery('');
    setSearchResults(null);
    setSyncedSkills([]);
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

    void fetchHealth(codespaceId);
    void fetchInsights(codespaceId);
  }, [codespaceId, fetchHealth, fetchInsights]);

  // ---------------------------------------------------------------------------
  // Lazy-load skills tab data
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (activeTab !== 'skills' || skillsLoadedRef.current) return;
    skillsLoadedRef.current = true;
    void fetchSyncedSkills(codespaceId);
    void fetchSkillMetrics(codespaceId);
  }, [activeTab, codespaceId, fetchSyncedSkills, fetchSkillMetrics]);

  // ---------------------------------------------------------------------------
  // Lazy-load dream tab data
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (activeTab !== 'dream' || dreamLoadedRef.current) return;
    dreamLoadedRef.current = true;
    void fetchDreamSessions(codespaceId);
    void fetchSuggestions(codespaceId);
  }, [activeTab, codespaceId, fetchDreamSessions, fetchSuggestions]);

  // ---------------------------------------------------------------------------
  // Poll dream status while running (every 5s)
  // ---------------------------------------------------------------------------

  useWatchEffect(() => {
    if (!isDreamRunning) return;

    const csId = codespaceId;
    const interval = setInterval(async () => {
      try {
        const result = await apiClient.memory.getDreamSessions(csId);
        if (currentCodespaceRef.current !== csId) return;
        if (result.ok) {
          const data = result.data;
          setDreamSessions(data);
          const stillRunning = data.some((s) => s.status === 'running');
          if (!stillRunning) {
            setIsDreamRunning(false);
            void fetchSuggestions(csId);
          }
        }
      } catch {
        // Transient error — polling will retry on next interval
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isDreamRunning, codespaceId, fetchSuggestions]);

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

    setIsSearching(true);
    const csId = codespaceId;
    const requestId = ++searchRequestIdRef.current;

    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await apiClient.memory.search(csId, searchQuery.trim());
        // Only apply results if this is still the latest request
        if (requestId !== searchRequestIdRef.current) return;
        if (result.ok) {
          setSearchResults(result.data);
        } else {
          setSearchResults(null);
          toast.error(result.error?.message ?? 'Search failed');
        }
      } catch {
        if (requestId === searchRequestIdRef.current) {
          setSearchResults(null);
          toast.error('Search failed');
        }
      } finally {
        if (requestId === searchRequestIdRef.current) {
          setIsSearching(false);
        }
      }
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
    await fetchInsights(codespaceId);
  }, [codespaceId, fetchInsights]);

  const createInsight = useCallback(
    async (data: {
      content: string;
      source?: Insight['source'];
      tags?: string[];
      metadata?: Record<string, unknown>;
    }): Promise<boolean> => {
      if (!codespaceId) {
        toast.error('Select a codespace to create insights');
        return false;
      }
      return mutateAndRefresh({
        action: () => apiClient.memory.createInsight(codespaceId, data),
        successMessage: 'Insight created',
        errorMessage: 'Failed to create insight',
        refresh: () => fetchInsights(codespaceId),
      });
    },
    [codespaceId, fetchInsights]
  );

  const deleteInsight = useCallback(
    async (id: string): Promise<boolean> => {
      return mutateAndRefresh({
        action: () => apiClient.memory.deleteInsight(id),
        successMessage: 'Insight deleted',
        errorMessage: 'Failed to delete insight',
        refresh: () => fetchInsights(codespaceId),
      });
    },
    [codespaceId, fetchInsights]
  );

  const loadExecutions = useCallback(
    async (skillId: string) => {
      // Use ref-based cache to avoid stale closure issues
      if (skillExecutionsCacheRef.current.has(skillId)) return;
      skillExecutionsCacheRef.current.add(skillId);

      const csId = codespaceId;
      try {
        const result = await apiClient.memory.getSkillExecutions(csId, skillId);
        if (currentCodespaceRef.current !== csId) return;
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
      } catch {
        // Remove from cache so retry is possible
        skillExecutionsCacheRef.current.delete(skillId);
        if (currentCodespaceRef.current === csId) {
          toast.error('Failed to load executions');
        }
      }
    },
    [codespaceId]
  );

  const refreshSkillMetrics = useCallback(async () => {
    setSkillExecutions(new Map());
    skillExecutionsCacheRef.current = new Set();
    await fetchSkillMetrics(codespaceId);
  }, [codespaceId, fetchSkillMetrics]);

  const triggerDream = useCallback(async (): Promise<boolean> => {
    if (!codespaceId) {
      toast.error('Select a codespace to run a dream cycle');
      return false;
    }

    setIsDreamRunning(true);
    try {
      const result = await apiClient.memory.triggerDream(codespaceId);
      if (result.ok) {
        toast.success('Dream session started');
        await fetchDreamSessions(codespaceId);
        return true;
      }
      setIsDreamRunning(false);
      toast.error(result.error?.message ?? 'Failed to start dream session');
      return false;
    } catch {
      setIsDreamRunning(false);
      toast.error('Failed to start dream session');
      return false;
    }
  }, [codespaceId, fetchDreamSessions]);

  const refreshSuggestions = useCallback(async () => {
    await fetchSuggestions(codespaceId);
  }, [codespaceId, fetchSuggestions]);

  const acceptSuggestion = useCallback(
    async (id: string, notes?: string): Promise<boolean> =>
      mutateAndRefresh({
        action: () => apiClient.memory.acceptSuggestion(id, notes),
        successMessage: 'Suggestion accepted',
        errorMessage: 'Failed to accept suggestion',
        refresh: () => fetchSuggestions(codespaceId),
      }),
    [codespaceId, fetchSuggestions]
  );

  const rejectSuggestion = useCallback(
    async (id: string, notes?: string): Promise<boolean> =>
      mutateAndRefresh({
        action: () => apiClient.memory.rejectSuggestion(id, notes),
        successMessage: 'Suggestion rejected',
        errorMessage: 'Failed to reject suggestion',
        refresh: () => fetchSuggestions(codespaceId),
      }),
    [codespaceId, fetchSuggestions]
  );

  const modifySuggestion = useCallback(
    async (id: string, content: string, notes?: string): Promise<boolean> =>
      mutateAndRefresh({
        action: () => apiClient.memory.modifySuggestion(id, content, notes),
        successMessage: 'Suggestion modified',
        errorMessage: 'Failed to modify suggestion',
        refresh: () => fetchSuggestions(codespaceId),
      }),
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
      syncedSkills,
      syncedSkillsLoading,
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
      syncedSkills,
      syncedSkillsLoading,
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
