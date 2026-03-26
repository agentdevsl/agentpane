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
  /** Whether the folder panel (Tier 2) is open */
  isFolderPanelOpen: boolean;
  /** Whether the nav panel (Tier 3) is open */
  isNavPanelOpen: boolean;
  /** Folder panel width in px (persisted to localStorage) */
  folderPanelWidth: number;
  /** Nav panel width in px (persisted to localStorage) */
  navPanelWidth: number;
  /** Select a folder by ID */
  selectFolder: (folderId: string | null) => void;
  /** Toggle the folder panel open/closed */
  toggleFolderPanel: () => void;
  /** Toggle the nav panel open/closed */
  toggleNavPanel: () => void;
  /** Set the folder panel open state directly */
  setFolderPanelOpen: (open: boolean) => void;
  /** Set the nav panel open state directly */
  setNavPanelOpen: (open: boolean) => void;
  /** Set the folder panel width (in-memory, no persist) */
  setFolderPanelWidth: (width: number) => void;
  /** Set the nav panel width (in-memory, no persist) */
  setNavPanelWidth: (width: number) => void;
  /** Persist the folder panel width to localStorage */
  persistFolderPanelWidth: (width: number) => void;
  /** Persist the nav panel width to localStorage */
  persistNavPanelWidth: (width: number) => void;
  /** Refresh the folder list from the API */
  refreshFolders: () => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

const SELECTED_FOLDER_KEY = 'agentpane:selected-folder-id';
const FOLDER_PANEL_KEY = 'agentpane:folder-panel-open';
const NAV_PANEL_KEY = 'agentpane:nav-panel-open';
const FOLDER_PANEL_WIDTH_KEY = 'agentpane:folder-panel-width';
const NAV_PANEL_WIDTH_KEY = 'agentpane:nav-panel-width';

const DEFAULT_PANEL_WIDTH = 240;
export const MIN_PANEL_WIDTH = 160;
export const MAX_PANEL_WIDTH = 480;

// =============================================================================
// Helpers
// =============================================================================

function readBoolFromStorage(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function writeBoolToStorage(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore localStorage errors
  }
}

function readNumberFromStorage(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  } catch {
    return fallback;
  }
}

function writeNumberToStorage(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore localStorage errors
  }
}

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

  // Panel open/close states (persisted to localStorage)
  const [isFolderPanelOpen, setIsFolderPanelOpen] = useState(() =>
    readBoolFromStorage(FOLDER_PANEL_KEY, true)
  );
  const [isNavPanelOpen, setIsNavPanelOpen] = useState(() =>
    readBoolFromStorage(NAV_PANEL_KEY, true)
  );

  // Panel widths (persisted to localStorage)
  const [folderPanelWidth, setFolderPanelWidthState] = useState(() =>
    readNumberFromStorage(FOLDER_PANEL_WIDTH_KEY, DEFAULT_PANEL_WIDTH)
  );
  const [navPanelWidth, setNavPanelWidthState] = useState(() =>
    readNumberFromStorage(NAV_PANEL_WIDTH_KEY, DEFAULT_PANEL_WIDTH)
  );

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

  // Select a folder and persist to localStorage; auto-open nav panel
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
    // Auto-open the nav panel when a folder is selected
    if (folderId) {
      setIsNavPanelOpen(true);
      writeBoolToStorage(NAV_PANEL_KEY, true);
    }
  }, []);

  // Panel toggle helpers
  const toggleFolderPanel = useCallback(() => {
    setIsFolderPanelOpen((prev) => {
      const next = !prev;
      writeBoolToStorage(FOLDER_PANEL_KEY, next);
      return next;
    });
  }, []);

  const toggleNavPanel = useCallback(() => {
    setIsNavPanelOpen((prev) => {
      const next = !prev;
      writeBoolToStorage(NAV_PANEL_KEY, next);
      return next;
    });
  }, []);

  const setFolderPanelOpen = useCallback((open: boolean) => {
    setIsFolderPanelOpen(open);
    writeBoolToStorage(FOLDER_PANEL_KEY, open);
  }, []);

  const setNavPanelOpen = useCallback((open: boolean) => {
    setIsNavPanelOpen(open);
    writeBoolToStorage(NAV_PANEL_KEY, open);
  }, []);

  // Width setters (in-memory only — called on every mousemove during drag)
  const setFolderPanelWidth = useCallback((width: number) => {
    setFolderPanelWidthState(width);
  }, []);

  const setNavPanelWidth = useCallback((width: number) => {
    setNavPanelWidthState(width);
  }, []);

  // Width persisters (called once on drag end)
  const persistFolderPanelWidth = useCallback((width: number) => {
    setFolderPanelWidthState(width);
    writeNumberToStorage(FOLDER_PANEL_WIDTH_KEY, width);
  }, []);

  const persistNavPanelWidth = useCallback((width: number) => {
    setNavPanelWidthState(width);
    writeNumberToStorage(NAV_PANEL_WIDTH_KEY, width);
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
      isFolderPanelOpen,
      isNavPanelOpen,
      folderPanelWidth,
      navPanelWidth,
      selectFolder,
      toggleFolderPanel,
      toggleNavPanel,
      setFolderPanelOpen,
      setNavPanelOpen,
      setFolderPanelWidth,
      setNavPanelWidth,
      persistFolderPanelWidth,
      persistNavPanelWidth,
      refreshFolders: fetchFolders,
    }),
    [
      folders,
      selectedFolderId,
      selectedFolder,
      isLoading,
      isFolderPanelOpen,
      isNavPanelOpen,
      folderPanelWidth,
      navPanelWidth,
      selectFolder,
      toggleFolderPanel,
      toggleNavPanel,
      setFolderPanelOpen,
      setNavPanelOpen,
      setFolderPanelWidth,
      setNavPanelWidth,
      persistFolderPanelWidth,
      persistNavPanelWidth,
      fetchFolders,
    ]
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
