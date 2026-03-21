import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient, type ProjectFolderItem } from '@/lib/api/client';

// =============================================================================
// Types
// =============================================================================

interface FolderDataContextValue {
  /** All accessible project folders */
  folders: ProjectFolderItem[];
  /** Currently selected folder ID (persisted to localStorage) */
  selectedFolderId: string | null;
  /** Currently selected folder object */
  selectedFolder: ProjectFolderItem | null;
  /** Whether folders are loading */
  isLoading: boolean;
  /** Select a folder by ID */
  selectFolder: (folderId: string | null) => void;
  /** Refresh the folder list from the API */
  refreshFolders: () => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

const SELECTED_FOLDER_KEY = 'agentpane:selected-folder-id';

// =============================================================================
// Contexts
// =============================================================================

const FolderDataContext = createContext<FolderDataContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface FolderContextProviderProps {
  children: ReactNode;
}

export function FolderContextProvider({ children }: FolderContextProviderProps): React.JSX.Element {
  const [folders, setFolders] = useState<ProjectFolderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(SELECTED_FOLDER_KEY);
    } catch {
      return null;
    }
  });

  // Fetch folders from API
  const fetchFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await apiClient.projectFolders.list();
      if (result.ok) {
        setFolders(result.data.items);
      }
    } catch {
      // Folder fetch failure is non-critical
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch on mount
  useMountEffect(() => {
    void fetchFolders();
  });

  // Select a folder and persist to localStorage
  const selectFolder = useCallback((folderId: string | null) => {
    setSelectedFolderId(folderId);
    try {
      if (folderId) {
        localStorage.setItem(SELECTED_FOLDER_KEY, folderId);
      } else {
        localStorage.removeItem(SELECTED_FOLDER_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Derive selected folder from ID
  const selectedFolder = useMemo(() => {
    if (!selectedFolderId) return null;
    return folders.find((f) => f.id === selectedFolderId) ?? null;
  }, [selectedFolderId, folders]);

  const value = useMemo<FolderDataContextValue>(
    () => ({
      folders,
      selectedFolderId,
      selectedFolder,
      isLoading,
      selectFolder,
      refreshFolders: fetchFolders,
    }),
    [folders, selectedFolderId, selectedFolder, isLoading, selectFolder, fetchFolders]
  );

  return <FolderDataContext.Provider value={value}>{children}</FolderDataContext.Provider>;
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Access the selected folder and folder list.
 */
export function useSelectedFolder(): FolderDataContextValue {
  const context = useContext(FolderDataContext);
  if (!context) {
    throw new Error('useSelectedFolder must be used within a FolderContextProvider');
  }
  return context;
}

/**
 * Access folder data (alias for useSelectedFolder).
 */
export function useFolderData(): FolderDataContextValue {
  return useSelectedFolder();
}
