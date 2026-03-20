import { useNavigate, useParams } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ProjectPickerItem,
  useRecentProjects,
} from '@/app/components/features/project-picker';
import { apiClient, type ProjectSummaryItem } from '@/lib/api/client';

// =============================================================================
// Types
// =============================================================================

/**
 * FC-010: Data-only context -- project list, loading state, current project.
 */
interface ProjectDataContextValue {
  /** Currently selected project (with summary data) */
  currentProject: ProjectSummaryItem | null;
  /** Currently selected project ID from URL */
  currentProjectId: string | undefined;
  /** All projects for the picker */
  allProjects: ProjectPickerItem[];
  /** Recent projects for the picker */
  recentProjects: ProjectPickerItem[];
  /** Whether projects are loading */
  isLoading: boolean;
  /** Error if project fetch failed */
  error: Error | undefined;
  /** Refresh projects data */
  refreshProjects: () => Promise<void>;
  /** Select a project (navigates and updates recent) */
  selectProject: (project: ProjectPickerItem) => void;
}

/**
 * FC-010: Picker/modal UI state -- separated from data concerns.
 */
interface ProjectPickerContextValue {
  /** Whether the project picker modal is open */
  isPickerOpen: boolean;
  /** Open the project picker modal */
  openPicker: () => void;
  /** Close the project picker modal */
  closePicker: () => void;
  /** Whether the new project dialog is open */
  isNewProjectDialogOpen: boolean;
  /** Open the new project dialog */
  openNewProjectDialog: () => void;
  /** Close the new project dialog */
  closeNewProjectDialog: () => void;
}

/**
 * Combined context for backward compatibility.
 * Existing consumers of `useProjectContext()` continue to work unchanged.
 */
interface ProjectContextValue extends ProjectDataContextValue, ProjectPickerContextValue {}

// =============================================================================
// Contexts (FC-010: split into data vs. picker)
// =============================================================================

const ProjectDataContext = createContext<ProjectDataContextValue | null>(null);
const ProjectPickerContext = createContext<ProjectPickerContextValue | null>(null);

/**
 * Legacy combined context -- kept for backward compat with `useProjectContext()`.
 */
const ProjectContext = createContext<ProjectContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface ProjectContextProviderProps {
  children: ReactNode;
}

export function ProjectContextProvider({
  children,
}: ProjectContextProviderProps): React.JSX.Element {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const projectId = (params as { projectId?: string }).projectId;

  // Modal states (FC-010: these belong to PickerContext)
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false);

  // Project data states
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // FC-001: Track whether projects have been fetched to avoid redundant requests.
  // Only fetch when a projectId is in the URL or the picker opens.
  const hasFetched = useRef(false);

  // Recent projects from localStorage
  const { recentProjectIds, addRecentProject } = useRecentProjects();

  // Fetch all projects
  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await apiClient.projects.listWithSummaries({ limit: 100 });
      if (result.ok) {
        setProjectSummaries(result.data.items);
      } else {
        setError(new Error(result.error.message));
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch projects'));
    } finally {
      setIsLoading(false);
      hasFetched.current = true;
    }
  }, []);

  // FC-001: Deferred fetch -- only runs when projectId is present or picker opens
  useEffect(() => {
    if (!hasFetched.current && projectId) {
      void fetchProjects();
    }
  }, [projectId, fetchProjects]);

  // Current project from summaries
  const currentProject = useMemo(() => {
    if (!projectId) return null;
    return projectSummaries.find((p) => p.project.id === projectId) ?? null;
  }, [projectId, projectSummaries]);

  // Convert summaries to picker items
  const allProjects = useMemo<ProjectPickerItem[]>(() => {
    const colors = ['blue', 'green', 'purple', 'orange', 'red'] as const;
    return projectSummaries.map((summary) => {
      const { project } = summary;
      // Derive icon color from project name hash for consistency
      const hash = project.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const color = colors[hash % colors.length] ?? 'blue';

      return {
        id: project.id,
        name: project.name,
        path: project.path,
        icon: {
          type: 'initials' as const,
          value: project.name.slice(0, 2).toUpperCase(),
          color,
        },
        isActive: project.id === projectId,
        stats: {
          activeAgents: summary.runningAgents.length,
          totalTasks: summary.taskCounts.total,
          backlogTasks: summary.taskCounts.backlog,
          inProgressTasks: summary.taskCounts.inProgress,
        },
        lastAccessedAt: project.updatedAt ?? new Date(),
      };
    });
  }, [projectSummaries, projectId]);

  // Recent projects filtered from all
  const recentProjects = useMemo<ProjectPickerItem[]>(() => {
    return recentProjectIds
      .map((id) => allProjects.find((p) => p.id === id))
      .filter((p): p is ProjectPickerItem => p !== undefined);
  }, [recentProjectIds, allProjects]);

  // Modal controls
  const openPicker = useCallback(() => {
    // FC-001: Fetch on first picker open if not already loaded
    if (!hasFetched.current) {
      void fetchProjects();
    }
    setIsPickerOpen(true);
  }, [fetchProjects]);
  const closePicker = useCallback(() => setIsPickerOpen(false), []);
  const openNewProjectDialog = useCallback(() => {
    setIsPickerOpen(false);
    setIsNewProjectDialogOpen(true);
  }, []);
  const closeNewProjectDialog = useCallback(() => setIsNewProjectDialogOpen(false), []);

  // Select project - navigate and track recent
  const selectProject = useCallback(
    (project: ProjectPickerItem) => {
      addRecentProject(project.id);
      navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
      setIsPickerOpen(false);
    },
    [addRecentProject, navigate]
  );

  // FC-010: Build separate context values
  const dataValue = useMemo<ProjectDataContextValue>(
    () => ({
      currentProject,
      currentProjectId: projectId,
      allProjects,
      recentProjects,
      isLoading,
      error,
      refreshProjects: fetchProjects,
      selectProject,
    }),
    [
      currentProject,
      projectId,
      allProjects,
      recentProjects,
      isLoading,
      error,
      fetchProjects,
      selectProject,
    ]
  );

  const pickerValue = useMemo<ProjectPickerContextValue>(
    () => ({
      isPickerOpen,
      openPicker,
      closePicker,
      isNewProjectDialogOpen,
      openNewProjectDialog,
      closeNewProjectDialog,
    }),
    [
      isPickerOpen,
      openPicker,
      closePicker,
      isNewProjectDialogOpen,
      openNewProjectDialog,
      closeNewProjectDialog,
    ]
  );

  // Combined value for backward compatibility
  const combinedValue = useMemo<ProjectContextValue>(
    () => ({ ...dataValue, ...pickerValue }),
    [dataValue, pickerValue]
  );

  return (
    <ProjectDataContext.Provider value={dataValue}>
      <ProjectPickerContext.Provider value={pickerValue}>
        <ProjectContext.Provider value={combinedValue}>{children}</ProjectContext.Provider>
      </ProjectPickerContext.Provider>
    </ProjectDataContext.Provider>
  );
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Access the full project context (backward-compatible combined hook).
 * Must be used within a ProjectContextProvider.
 */
export function useProjectContext(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectContext must be used within a ProjectContextProvider');
  }
  return context;
}

/**
 * FC-010: Access only data-related project context (avoids re-renders from modal state).
 */
export function useProjectData(): ProjectDataContextValue {
  const context = useContext(ProjectDataContext);
  if (!context) {
    throw new Error('useProjectData must be used within a ProjectContextProvider');
  }
  return context;
}

/**
 * FC-010: Access only picker/modal UI state (avoids re-renders from data changes).
 */
export function useProjectPicker(): ProjectPickerContextValue {
  const context = useContext(ProjectPickerContext);
  if (!context) {
    throw new Error('useProjectPicker must be used within a ProjectContextProvider');
  }
  return context;
}
