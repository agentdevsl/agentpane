import type { Codespace } from '@/db/schema';

/**
 * Project icon configuration
 */
export interface ProjectIcon {
  type: 'emoji' | 'initials';
  value: string;
  color: ProjectIconColor;
}

export type ProjectIconColor = 'blue' | 'green' | 'purple' | 'orange' | 'red';

/**
 * Project statistics for display
 */
export interface ProjectStats {
  activeAgents: number;
  totalTasks: number;
  backlogTasks: number;
  inProgressTasks: number;
}

/**
 * Project item displayed in the picker list
 */
export interface ProjectPickerItem {
  id: string;
  name: string;
  path: string;
  icon: ProjectIcon;
  isActive: boolean;
  stats: ProjectStats;
  lastAccessedAt: Date | string;
}

/**
 * Props for the ProjectPicker component
 */
export interface ProjectPickerProps {
  /** Whether the modal is open */
  open: boolean;
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void;
  /** Currently selected project ID */
  selectedProjectId?: string;
  /** Callback when a project is selected */
  onProjectSelect: (project: ProjectPickerItem) => void;
  /** Callback when "New Project" button is clicked */
  onNewProjectClick: () => void;
  /** Recent projects (shown in "Recent Projects" section) */
  recentProjects: ProjectPickerItem[];
  /** All available projects */
  allProjects: ProjectPickerItem[];
  /** Loading state */
  isLoading?: boolean;
  /** Error state */
  error?: Error;
}

/**
 * Internal state for the ProjectPicker component
 */
export interface ProjectPickerState {
  searchQuery: string;
  selectedIndex: number;
  filteredRecent: ProjectPickerItem[];
  filteredAll: ProjectPickerItem[];
}

/**
 * Maps a Project and its summary data to a ProjectPickerItem
 */
export function mapProjectToPickerItem(
  project: Codespace,
  options: {
    isActive?: boolean;
    activeAgents?: number;
    totalTasks?: number;
    backlogTasks?: number;
    inProgressTasks?: number;
    lastAccessedAt?: Date | string;
  } = {}
): ProjectPickerItem {
  // Derive icon color from project name hash for consistency
  const colors: ProjectIconColor[] = ['blue', 'green', 'purple', 'orange', 'red'];
  const hash = project.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const color: ProjectIconColor = colors[hash % colors.length] ?? 'blue';

  return {
    id: project.id,
    name: project.name,
    path: project.path,
    icon: {
      type: 'initials',
      value: project.name.slice(0, 2).toUpperCase(),
      color,
    },
    isActive: options.isActive ?? false,
    stats: {
      activeAgents: options.activeAgents ?? 0,
      totalTasks: options.totalTasks ?? 0,
      backlogTasks: options.backlogTasks ?? 0,
      inProgressTasks: options.inProgressTasks ?? 0,
    },
    lastAccessedAt: options.lastAccessedAt ?? project.updatedAt,
  };
}
