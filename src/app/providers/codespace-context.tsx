import { useNavigate, useParams } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ProjectPickerItem,
  useRecentProjects,
} from '@/app/components/features/project-picker';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type CodespaceListItem, type ProjectSummaryItem } from '@/lib/api/client';
import { useSelectedFolder } from './folder-context';

// =============================================================================
// Types
// =============================================================================

/**
 * Data-only context -- codespace list, loading state, current codespace.
 */
interface CodespaceDataContextValue {
  /** Currently selected codespace (with summary data) */
  currentCodespace: ProjectSummaryItem | null;
  /** Currently selected codespace ID from URL */
  currentCodespaceId: string | undefined;
  /** Codespaces filtered by selected folder (for NavPanel list) */
  allCodespaces: ProjectPickerItem[];
  /** All codespaces unfiltered (for picker dialog) */
  allCodespacesUnfiltered: ProjectPickerItem[];
  /** Unfiltered codespace list (raw API data for folder counts) */
  rawCodespaceList: CodespaceListItem[];
  /** Recent codespaces for the picker */
  recentCodespaces: ProjectPickerItem[];
  /** Whether codespaces are loading */
  isLoading: boolean;
  /** Error if codespace fetch failed */
  error: Error | undefined;
  /** Refresh codespaces data */
  refreshCodespaces: () => Promise<void>;
  /** Select a codespace (navigates and updates recent) */
  selectCodespace: (codespace: ProjectPickerItem) => void;
}

/**
 * Picker/modal UI state -- separated from data concerns.
 */
interface CodespacePickerContextValue {
  /** Whether the codespace picker modal is open */
  isPickerOpen: boolean;
  /** Open the codespace picker modal */
  openPicker: () => void;
  /** Close the codespace picker modal */
  closePicker: () => void;
  /** Whether the new codespace dialog is open */
  isNewCodespaceDialogOpen: boolean;
  /** Open the new codespace dialog */
  openNewCodespaceDialog: () => void;
  /** Close the new codespace dialog */
  closeNewCodespaceDialog: () => void;
}

/**
 * Combined context for backward compatibility.
 */
interface CodespaceContextValue extends CodespaceDataContextValue, CodespacePickerContextValue {}

// =============================================================================
// Contexts
// =============================================================================

const CodespaceDataContext = createContext<CodespaceDataContextValue | null>(null);
const CodespacePickerContext = createContext<CodespacePickerContextValue | null>(null);
const CodespaceContext = createContext<CodespaceContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface CodespaceContextProviderProps {
  children: ReactNode;
}

export function CodespaceContextProvider({
  children,
}: CodespaceContextProviderProps): React.JSX.Element {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const urlCodespaceId = (params as { codespaceId?: string }).codespaceId;

  // Remember the last selected codespace ID so the sidebar stays visible
  // even when navigating to non-codespace routes (e.g., /templates/project)
  const [rememberedCodespaceId, setRememberedCodespaceId] = useState<string | undefined>(
    urlCodespaceId
  );
  if (urlCodespaceId && urlCodespaceId !== rememberedCodespaceId) {
    setRememberedCodespaceId(urlCodespaceId);
  }
  const codespaceId = urlCodespaceId ?? rememberedCodespaceId;

  // Get selected folder for filtering
  const { selectedFolderId } = useSelectedFolder();

  // Modal states
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isNewCodespaceDialogOpen, setIsNewCodespaceDialogOpen] = useState(false);

  // Codespace data states
  const [codespaceList, setCodespaceList] = useState<CodespaceListItem[]>([]);
  const [currentCodespaceSummary, setCurrentCodespaceSummary] = useState<ProjectSummaryItem | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Track whether codespaces have been fetched to avoid redundant requests
  const hasFetched = useRef(false);

  // Recent codespaces from localStorage
  const { recentProjectIds: recentCodespaceIds, addRecentProject: addRecentCodespace } =
    useRecentProjects();

  // Fetch lightweight codespace list
  const fetchCodespaces = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await apiClient.codespaces.list({ limit: 100 });
      if (result.ok) {
        setCodespaceList(result.data.items);
      } else {
        setError(new Error(result.error.message));
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch codespaces'));
    } finally {
      setIsLoading(false);
      hasFetched.current = true;
    }
  }, []);

  // Eager fetch -- always fetch on mount so FolderPanel can compute per-folder counts
  useMountEffect(() => {
    void fetchCodespaces();
  });

  // Fetch summary data only for the current codespace when codespaceId changes
  useWatchEffect(() => {
    if (!codespaceId) {
      setCurrentCodespaceSummary(null);
      return;
    }
    const fetchCurrentSummary = async () => {
      try {
        const result = await apiClient.codespaces.listWithSummaries({ limit: 100 });
        if (result.ok) {
          const summary = result.data.items.find((p) => p.codespace.id === codespaceId) ?? null;
          setCurrentCodespaceSummary(summary);
        }
      } catch {
        // Summary fetch failure is non-critical
      }
    };
    void fetchCurrentSummary();
  }, [codespaceId]);

  // Current codespace from summary
  const currentCodespace = useMemo(() => {
    return currentCodespaceSummary ?? null;
  }, [currentCodespaceSummary]);

  // Convert codespace list item to picker item
  const toPickerItem = useCallback(
    (codespace: CodespaceListItem): ProjectPickerItem => {
      const colors = ['blue', 'green', 'purple', 'orange', 'red'] as const;
      const hash = codespace.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const color = colors[hash % colors.length] ?? 'blue';
      return {
        id: codespace.id,
        name: codespace.name,
        path: codespace.path,
        icon: {
          type: 'initials' as const,
          value: codespace.name.slice(0, 2).toUpperCase(),
          color,
        },
        isActive: codespace.id === codespaceId,
        stats: { activeAgents: 0, totalTasks: 0, backlogTasks: 0, inProgressTasks: 0 },
        lastAccessedAt: codespace.updatedAt ?? new Date(),
      };
    },
    [codespaceId]
  );

  // Codespaces filtered by selected folder (for NavPanel list)
  const allCodespaces = useMemo<ProjectPickerItem[]>(() => {
    const filtered = selectedFolderId
      ? codespaceList.filter((cs) => cs.projectFolderId === selectedFolderId)
      : codespaceList;
    return filtered.map(toPickerItem);
  }, [codespaceList, selectedFolderId, toPickerItem]);

  // All codespaces unfiltered (for picker dialog)
  const allCodespacesUnfiltered = useMemo<ProjectPickerItem[]>(() => {
    return codespaceList.map(toPickerItem);
  }, [codespaceList, toPickerItem]);

  // Recent codespaces (from unfiltered list so they show across all folders)
  const recentCodespaces = useMemo<ProjectPickerItem[]>(() => {
    return recentCodespaceIds
      .map((id) => allCodespacesUnfiltered.find((p) => p.id === id))
      .filter((p): p is ProjectPickerItem => p !== undefined);
  }, [recentCodespaceIds, allCodespacesUnfiltered]);

  // Modal controls
  const openPicker = useCallback(() => {
    if (!hasFetched.current) {
      void fetchCodespaces();
    }
    setIsPickerOpen(true);
  }, [fetchCodespaces]);
  const closePicker = useCallback(() => setIsPickerOpen(false), []);
  const openNewCodespaceDialog = useCallback(() => {
    setIsPickerOpen(false);
    setIsNewCodespaceDialogOpen(true);
  }, []);
  const closeNewCodespaceDialog = useCallback(() => setIsNewCodespaceDialogOpen(false), []);

  // Select codespace - navigate, track recent, and reassign to current folder if needed
  const selectCodespace = useCallback(
    (codespace: ProjectPickerItem) => {
      addRecentCodespace(codespace.id);

      // If a folder is selected, reassign the codespace to that folder
      if (selectedFolderId) {
        const existing = codespaceList.find((cs) => cs.id === codespace.id);
        if (existing && existing.projectFolderId !== selectedFolderId) {
          apiClient.codespaces
            .update(codespace.id, { projectFolderId: selectedFolderId })
            .then((result) => {
              if (result.ok) {
                // Update local list so the NavPanel and folder counts reflect the change
                setCodespaceList((prev) =>
                  prev.map((cs) =>
                    cs.id === codespace.id ? { ...cs, projectFolderId: selectedFolderId } : cs
                  )
                );
              }
            });
        }
      }

      navigate({ to: '/codespaces/$codespaceId', params: { codespaceId: codespace.id } });
      setIsPickerOpen(false);
    },
    [addRecentCodespace, navigate, selectedFolderId, codespaceList]
  );

  // Build separate context values
  const dataValue = useMemo<CodespaceDataContextValue>(
    () => ({
      currentCodespace,
      currentCodespaceId: codespaceId,
      allCodespaces,
      allCodespacesUnfiltered,
      rawCodespaceList: codespaceList,
      recentCodespaces,
      isLoading,
      error,
      refreshCodespaces: fetchCodespaces,
      selectCodespace,
    }),
    [
      currentCodespace,
      codespaceId,
      allCodespaces,
      allCodespacesUnfiltered,
      codespaceList,
      recentCodespaces,
      isLoading,
      error,
      fetchCodespaces,
      selectCodespace,
    ]
  );

  const pickerValue = useMemo<CodespacePickerContextValue>(
    () => ({
      isPickerOpen,
      openPicker,
      closePicker,
      isNewCodespaceDialogOpen,
      openNewCodespaceDialog,
      closeNewCodespaceDialog,
    }),
    [
      isPickerOpen,
      openPicker,
      closePicker,
      isNewCodespaceDialogOpen,
      openNewCodespaceDialog,
      closeNewCodespaceDialog,
    ]
  );

  // Combined value for backward compatibility
  const combinedValue = useMemo<CodespaceContextValue>(
    () => ({ ...dataValue, ...pickerValue }),
    [dataValue, pickerValue]
  );

  return (
    <CodespaceDataContext.Provider value={dataValue}>
      <CodespacePickerContext.Provider value={pickerValue}>
        <CodespaceContext.Provider value={combinedValue}>{children}</CodespaceContext.Provider>
      </CodespacePickerContext.Provider>
    </CodespaceDataContext.Provider>
  );
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Access the full codespace context (backward-compatible combined hook).
 * Must be used within a CodespaceContextProvider.
 */
export function useCodespaceContext(): CodespaceContextValue {
  const context = useContext(CodespaceContext);
  if (!context) {
    throw new Error('useCodespaceContext must be used within a CodespaceContextProvider');
  }
  return context;
}

/**
 * Access only data-related codespace context (avoids re-renders from modal state).
 */
export function useCodespaceData(): CodespaceDataContextValue {
  const context = useContext(CodespaceDataContext);
  if (!context) {
    throw new Error('useCodespaceData must be used within a CodespaceContextProvider');
  }
  return context;
}
