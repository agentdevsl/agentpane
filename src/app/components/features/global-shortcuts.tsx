import { useNavigate } from '@tanstack/react-router';
import React, { Suspense, useCallback, useMemo } from 'react';
import { type Shortcut, useKeyboardShortcuts } from '@/app/hooks/use-keyboard-shortcuts';
import { useProjectContext } from '@/app/providers/project-context';
import { useShortcutsContext } from '@/app/providers/shortcuts-provider';
import { apiClient } from '@/lib/api/client';
import type { Result } from '@/lib/utils/result';
import type { SandboxType } from './new-project-dialog';

// Lazy-load heavy dialog component (FC-012)
const NewProjectDialog = React.lazy(() =>
  import('./new-project-dialog').then((m) => ({ default: m.NewProjectDialog }))
);

import { ProjectPicker } from './project-picker';
import { ShortcutsHelp } from './shortcuts-help';

// =============================================================================
// Types
// =============================================================================

interface GlobalShortcutsProps {
  /** Callback when project picker should open */
  onOpenProjectPicker?: () => void;
  /** Callback when new project dialog should open */
  onNewProject?: () => void;
  /** Callback to run the selected agent */
  onRunAgent?: () => void;
  /** Callback to stop the running agent */
  onStopAgent?: () => void;
  /** Callback to create a new task */
  onNewTask?: () => void;
  /** Callback to approve a waiting task */
  onApproveTask?: () => void;
  /** Condition to check if an agent is selected */
  hasSelectedAgent?: () => boolean;
  /** Condition to check if an agent is running */
  hasRunningAgent?: () => boolean;
  /** Condition to check if there's a task waiting for approval */
  hasWaitingTask?: () => boolean;
}

// =============================================================================
// Hook for Global Shortcuts Registration
// =============================================================================

/**
 * Hook to use global keyboard shortcuts
 *
 * This should be called in a component that has access to all the necessary
 * callbacks and state for global actions.
 */
export function useGlobalShortcuts(props: GlobalShortcutsProps = {}): void {
  const {
    onOpenProjectPicker,
    onNewProject,
    onRunAgent,
    onStopAgent,
    onNewTask,
    onApproveTask,
    hasSelectedAgent,
    hasRunningAgent,
    hasWaitingTask,
  } = props;

  const navigate = useNavigate();
  const shortcutsContext = useShortcutsContext();
  const { setHelpOpen } = shortcutsContext;

  // Define all global shortcuts
  const shortcuts = useMemo<Shortcut[]>(() => {
    const result: Shortcut[] = [];

    // Navigation shortcuts
    result.push({
      key: '1',
      meta: true,
      description: 'Go to Agents view',
      category: 'views',
      action: () => {
        navigate({ to: '/agents' });
      },
    });

    result.push({
      key: '2',
      meta: true,
      description: 'Go to Tasks/Kanban',
      category: 'views',
      action: () => {
        // Navigate to the first project's tasks or just /projects
        navigate({ to: '/projects' });
      },
    });

    // Project picker
    if (onOpenProjectPicker) {
      result.push({
        key: 'p',
        meta: true,
        description: 'Open project picker',
        category: 'navigation',
        action: onOpenProjectPicker,
      });
    }

    // New project
    if (onNewProject) {
      result.push({
        key: 'n',
        meta: true,
        shift: true,
        description: 'New project',
        category: 'actions',
        action: onNewProject,
      });
    }

    // Run agent
    if (onRunAgent) {
      result.push({
        key: 'r',
        meta: true,
        description: 'Run selected agent',
        category: 'actions',
        action: onRunAgent,
        when: hasSelectedAgent,
      });
    }

    // Stop agent
    if (onStopAgent) {
      result.push({
        key: '.',
        meta: true,
        description: 'Stop agent',
        category: 'actions',
        action: onStopAgent,
        when: hasRunningAgent,
      });
    }

    // New task
    if (onNewTask) {
      result.push({
        key: 't',
        meta: true,
        description: 'New task',
        category: 'actions',
        action: onNewTask,
      });
    }

    // Approve task
    if (onApproveTask) {
      result.push({
        key: 'Enter',
        meta: true,
        description: 'Approve task',
        category: 'actions',
        action: onApproveTask,
        when: hasWaitingTask,
      });
    }

    // Help modal (Cmd+/)
    result.push({
      key: '/',
      meta: true,
      description: 'Show keyboard shortcuts',
      category: 'navigation',
      action: () => setHelpOpen(true),
    });

    return result;
  }, [
    navigate,
    setHelpOpen,
    onOpenProjectPicker,
    onNewProject,
    onRunAgent,
    onStopAgent,
    onNewTask,
    onApproveTask,
    hasSelectedAgent,
    hasRunningAgent,
    hasWaitingTask,
  ]);

  // Register shortcuts
  useKeyboardShortcuts(shortcuts, shortcutsContext);
}

// =============================================================================
// Component for Basic Global Shortcuts
// =============================================================================

/**
 * Component that registers basic global shortcuts (navigation and help)
 *
 * Place this component inside ShortcutsProvider to enable basic shortcuts.
 * For action shortcuts (run agent, new task, etc.), use the useGlobalShortcuts
 * hook in a component that has access to the necessary state and callbacks.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <ShortcutsProvider>
 *       <GlobalShortcuts />
 *       <YourApp />
 *     </ShortcutsProvider>
 *   );
 * }
 * ```
 */
export function GlobalShortcuts(): React.JSX.Element {
  const navigate = useNavigate();
  const shortcutsContext = useShortcutsContext();
  const { setHelpOpen } = shortcutsContext;

  // Basic navigation and help shortcuts
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: '1',
        meta: true,
        description: 'Go to Agents view',
        category: 'views',
        action: () => navigate({ to: '/agents' }),
      },
      {
        key: '2',
        meta: true,
        description: 'Go to Tasks/Kanban',
        category: 'views',
        action: () => navigate({ to: '/projects' }),
      },
      {
        key: '/',
        meta: true,
        description: 'Show keyboard shortcuts',
        category: 'navigation',
        action: () => setHelpOpen(true),
      },
    ],
    [navigate, setHelpOpen]
  );

  useKeyboardShortcuts(shortcuts, shortcutsContext);

  return <ShortcutsHelp />;
}

// =============================================================================
// Component with Project Picker Integration
// =============================================================================

/**
 * Enhanced GlobalShortcuts component that includes the ProjectPicker and NewProjectDialog.
 * Use this in the root layout to enable Cmd+P project switching.
 */
export function GlobalShortcutsWithPicker(): React.JSX.Element {
  const navigate = useNavigate();
  const shortcutsContext = useShortcutsContext();
  const { setHelpOpen } = shortcutsContext;
  const {
    isPickerOpen,
    openPicker,
    closePicker,
    isNewProjectDialogOpen,
    openNewProjectDialog,
    closeNewProjectDialog,
    selectProject,
    allProjects,
    recentProjects,
    currentProjectId,
    isLoading,
    error,
    refreshProjects,
  } = useProjectContext();

  // Handle new project submission
  const handleNewProjectSubmit = useCallback(
    async (data: {
      name: string;
      path: string;
      description?: string;
      sandboxType?: SandboxType;
    }): Promise<Result<void, { code: string; message: string }>> => {
      try {
        const result = await apiClient.projects.create({
          name: data.name,
          path: data.path,
          description: data.description,
        });

        if (!result.ok) {
          return {
            ok: false,
            error: { code: result.error.code, message: result.error.message },
          };
        }

        // Refresh projects and navigate to new project
        await refreshProjects();
        navigate({ to: '/projects/$projectId', params: { projectId: result.data.id } });
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'UNKNOWN_ERROR',
            message: err instanceof Error ? err.message : 'Failed to create project',
          },
        };
      }
    },
    [navigate, refreshProjects]
  );

  // Handle path validation (stub implementation - returns basic validation result)
  const handleValidatePath = useCallback(
    async (
      pathToValidate: string
    ): Promise<
      Result<
        {
          name: string;
          path: string;
          defaultBranch: string;
          hasClaudeConfig: boolean;
          remoteUrl?: string;
        },
        unknown
      >
    > => {
      // TODO: Add API endpoint for path validation
      // For now, return a basic validation result
      const pathParts = pathToValidate.split('/');
      const name = pathParts[pathParts.length - 1] || 'unknown';
      return {
        ok: true,
        value: { name, path: pathToValidate, defaultBranch: 'main', hasClaudeConfig: false },
      };
    },
    []
  );

  // Shortcuts with project picker
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: '1',
        meta: true,
        description: 'Go to Agents view',
        category: 'views',
        action: () => navigate({ to: '/agents' }),
      },
      {
        key: '2',
        meta: true,
        description: 'Go to Tasks/Kanban',
        category: 'views',
        action: () => navigate({ to: '/projects' }),
      },
      {
        key: 'p',
        meta: true,
        description: 'Open project picker',
        category: 'navigation',
        action: openPicker,
      },
      {
        key: 'n',
        meta: true,
        shift: true,
        description: 'New project',
        category: 'actions',
        action: openNewProjectDialog,
      },
      {
        key: '/',
        meta: true,
        description: 'Show keyboard shortcuts',
        category: 'navigation',
        action: () => setHelpOpen(true),
      },
    ],
    [navigate, setHelpOpen, openPicker, openNewProjectDialog]
  );

  useKeyboardShortcuts(shortcuts, shortcutsContext);

  return (
    <>
      <ShortcutsHelp />
      <ProjectPicker
        open={isPickerOpen}
        onOpenChange={(open) => (open ? openPicker() : closePicker())}
        selectedProjectId={currentProjectId}
        onProjectSelect={selectProject}
        onNewProjectClick={openNewProjectDialog}
        recentProjects={recentProjects}
        allProjects={allProjects}
        isLoading={isLoading}
        error={error}
      />
      <Suspense fallback={null}>
        <NewProjectDialog
          open={isNewProjectDialogOpen}
          onOpenChange={(open) => (open ? openNewProjectDialog() : closeNewProjectDialog())}
          onSubmit={handleNewProjectSubmit}
          onValidatePath={handleValidatePath}
        />
      </Suspense>
    </>
  );
}
