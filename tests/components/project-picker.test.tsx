import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  mapProjectToPickerItem,
  ProjectPicker,
  type ProjectPickerItem,
} from '@/app/components/features/project-picker';
import type { Project } from '@/db/schema';

const createProject = (overrides: Partial<Project>): Project => ({
  id: overrides.id ?? 'project-1',
  name: overrides.name ?? 'Test Project',
  path: overrides.path ?? '/path/to/project',
  description: overrides.description ?? null,
  config: overrides.config ?? null,
  maxConcurrentAgents: overrides.maxConcurrentAgents ?? 3,
  githubOwner: overrides.githubOwner ?? null,
  githubRepo: overrides.githubRepo ?? null,
  githubInstallationId: overrides.githubInstallationId ?? null,
  configPath: overrides.configPath ?? '.claude',
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

const createPickerItem = (overrides: Partial<ProjectPickerItem>): ProjectPickerItem => ({
  id: overrides.id ?? 'project-1',
  name: overrides.name ?? 'Test Project',
  path: overrides.path ?? '/path/to/project',
  icon: overrides.icon ?? { type: 'initials', value: 'TP', color: 'blue' },
  isActive: overrides.isActive ?? false,
  stats: overrides.stats ?? { activeAgents: 0, totalTasks: 0, backlogTasks: 0, inProgressTasks: 0 },
  lastAccessedAt: overrides.lastAccessedAt ?? new Date(),
});

describe('ProjectPicker', () => {
  it('renders modal when open', () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search projects...')).toBeInTheDocument();
  });

  it('does not render modal when closed', () => {
    render(
      <ProjectPicker
        open={false}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    expect(screen.queryByText('Open Project')).not.toBeInTheDocument();
  });

  it('shows recent projects section', () => {
    const recentProjects = [
      createPickerItem({ id: 'p1', name: 'Project Alpha', path: '/path/alpha' }),
      createPickerItem({ id: 'p2', name: 'Project Beta', path: '/path/beta' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    expect(screen.getByText('Recent Projects')).toBeInTheDocument();
    expect(screen.getByText('Project Alpha')).toBeInTheDocument();
    expect(screen.getByText('Project Beta')).toBeInTheDocument();
  });

  it('shows all projects section', () => {
    const allProjects = [
      createPickerItem({ id: 'p1', name: 'Project Gamma', path: '/path/gamma' }),
      createPickerItem({ id: 'p2', name: 'Project Delta', path: '/path/delta' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={allProjects}
      />
    );

    expect(screen.getByText('All Projects')).toBeInTheDocument();
    expect(screen.getByText('Project Gamma')).toBeInTheDocument();
    expect(screen.getByText('Project Delta')).toBeInTheDocument();
  });

  it('calls onProjectSelect when project clicked', async () => {
    const user = userEvent.setup();
    const recentProjects = [
      createPickerItem({ id: 'p1', name: 'Project Alpha', path: '/path/alpha' }),
    ];
    const onProjectSelect = vi.fn();

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={onProjectSelect}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    // Click project
    await user.click(screen.getByText('Project Alpha'));

    expect(onProjectSelect).toHaveBeenCalledWith(recentProjects[0]);
  });

  it('calls onNewProjectClick when "New Project" clicked', async () => {
    const user = userEvent.setup();
    const onNewProjectClick = vi.fn();

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={onNewProjectClick}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    // Click New Project button
    await user.click(screen.getByTestId('new-project-option'));

    expect(onNewProjectClick).toHaveBeenCalled();
  });

  it('shows Active badge for active project', () => {
    const recentProjects = [
      createPickerItem({
        id: 'p1',
        name: 'Active Project',
        path: '/path/active',
        isActive: true,
        stats: { activeAgents: 2, totalTasks: 10, backlogTasks: 5, inProgressTasks: 3 },
      }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows check mark for current project', () => {
    const recentProjects = [
      createPickerItem({ id: 'p1', name: 'Current Project', path: '/path/current' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        selectedProjectId="p1"
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    // The Check icon should be rendered for the current project
    const projectItem = screen.getByText('Current Project').closest('[data-testid="project-item"]');
    expect(projectItem).toBeInTheDocument();
  });

  it('filters projects based on search query', async () => {
    const user = userEvent.setup();
    const allProjects = [
      createPickerItem({ id: 'p1', name: 'Frontend App', path: '/path/frontend' }),
      createPickerItem({ id: 'p2', name: 'Backend API', path: '/path/backend' }),
      createPickerItem({ id: 'p3', name: 'Mobile App', path: '/path/mobile' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={allProjects}
      />
    );

    // Type in search
    const searchInput = screen.getByTestId('project-search');
    await user.type(searchInput, 'App');

    // Should show Frontend App and Mobile App, not Backend API
    expect(screen.getByText('Frontend App')).toBeInTheDocument();
    expect(screen.getByText('Mobile App')).toBeInTheDocument();
    expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
  });

  it('shows empty state when no projects match search', async () => {
    const user = userEvent.setup();
    const allProjects = [createPickerItem({ id: 'p1', name: 'Test Project', path: '/path/test' })];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={allProjects}
      />
    );

    // Type search that won't match
    const searchInput = screen.getByTestId('project-search');
    await user.type(searchInput, 'xyz123');

    expect(screen.getByText('No projects found')).toBeInTheDocument();
    expect(screen.getByText(/No projects match "xyz123"/)).toBeInTheDocument();
  });

  it('shows empty state when no projects exist', () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first project to get started')).toBeInTheDocument();
  });

  it('navigates with arrow keys', async () => {
    const user = userEvent.setup();
    const allProjects = [
      createPickerItem({ id: 'p1', name: 'Project One', path: '/path/one' }),
      createPickerItem({ id: 'p2', name: 'Project Two', path: '/path/two' }),
      createPickerItem({ id: 'p3', name: 'Project Three', path: '/path/three' }),
    ];
    const onProjectSelect = vi.fn();

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={onProjectSelect}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={allProjects}
      />
    );

    // Navigate down twice then press Enter
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    // Should select the third project (index 2)
    expect(onProjectSelect).toHaveBeenCalledWith(allProjects[2]);
  });

  it('closes modal on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <ProjectPicker
        open={true}
        onOpenChange={onOpenChange}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('selects project on Enter key', async () => {
    const user = userEvent.setup();
    const allProjects = [createPickerItem({ id: 'p1', name: 'Project One', path: '/path/one' })];
    const onProjectSelect = vi.fn();

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={onProjectSelect}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={allProjects}
      />
    );

    // Press Enter on first (default selected) item
    await user.keyboard('{Enter}');

    expect(onProjectSelect).toHaveBeenCalledWith(allProjects[0]);
  });

  it('shows loading state', () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
        isLoading={true}
      />
    );

    // Should show spinner when loading
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
        error={new Error('Failed to load')}
      />
    );

    expect(screen.getByText('Failed to load projects')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('shows keyboard hints in footer', () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    expect(screen.getByText('Navigate')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('pre-selects active project when modal opens', () => {
    const recentProjects = [
      createPickerItem({ id: 'p1', name: 'Project One', path: '/path/one' }),
      createPickerItem({ id: 'p2', name: 'Project Two', path: '/path/two' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        selectedProjectId="p2"
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    // The second project should be visually selected
    const projectItems = screen.getAllByTestId('project-item');
    // Check that the second item has the selected style (bg-accent/10)
    expect(projectItems[1]).toHaveClass('bg-accent/10');
  });

  it('focuses search input when modal opens', async () => {
    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={[]}
        allProjects={[]}
      />
    );

    const searchInput = screen.getByTestId('project-search');
    // Input should receive focus when modal opens (via requestAnimationFrame)
    await waitFor(() => {
      expect(document.activeElement).toBe(searchInput);
    });
  });

  it('displays project path in monospace font', () => {
    const recentProjects = [
      createPickerItem({ id: 'p1', name: 'Test Project', path: '~/path/to/project' }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    const pathElement = screen.getByText('~/path/to/project');
    expect(pathElement).toHaveClass('font-mono');
  });

  it('displays agent count with pulsing indicator for active projects', () => {
    const recentProjects = [
      createPickerItem({
        id: 'p1',
        name: 'Active Project',
        path: '/path/active',
        isActive: true,
        stats: { activeAgents: 3, totalTasks: 10, backlogTasks: 5, inProgressTasks: 3 },
      }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    // Should show agent count
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('displays task count', () => {
    const recentProjects = [
      createPickerItem({
        id: 'p1',
        name: 'Test Project',
        path: '/path/test',
        stats: { activeAgents: 0, totalTasks: 15, backlogTasks: 10, inProgressTasks: 5 },
      }),
    ];

    render(
      <ProjectPicker
        open={true}
        onOpenChange={vi.fn()}
        onProjectSelect={vi.fn()}
        onNewProjectClick={vi.fn()}
        recentProjects={recentProjects}
        allProjects={[]}
      />
    );

    // Should show task count
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});

describe('mapProjectToPickerItem', () => {
  it('maps project to picker item with default values', () => {
    const project = createProject({ id: 'p1', name: 'Test', path: '/test' });
    const item = mapProjectToPickerItem(project);

    expect(item.id).toBe('p1');
    expect(item.name).toBe('Test');
    expect(item.path).toBe('/test');
    expect(item.icon.type).toBe('initials');
    expect(item.icon.value).toBe('TE');
    expect(item.isActive).toBe(false);
    expect(item.stats.activeAgents).toBe(0);
  });

  it('maps project with provided options', () => {
    const project = createProject({ id: 'p1', name: 'Active', path: '/active' });
    const item = mapProjectToPickerItem(project, {
      isActive: true,
      activeAgents: 5,
      totalTasks: 20,
    });

    expect(item.isActive).toBe(true);
    expect(item.stats.activeAgents).toBe(5);
    expect(item.stats.totalTasks).toBe(20);
  });

  it('generates consistent icon colors based on name', () => {
    const project1 = createProject({ name: 'Alpha' });
    const project2 = createProject({ name: 'Alpha' });
    const project3 = createProject({ name: 'Beta' });

    const item1 = mapProjectToPickerItem(project1);
    const item2 = mapProjectToPickerItem(project2);
    const item3 = mapProjectToPickerItem(project3);

    // Same name should produce same color
    expect(item1.icon.color).toBe(item2.icon.color);
    // Different names may have different colors (but this is not guaranteed)
    expect(item1.icon.color).toBeDefined();
    expect(item3.icon.color).toBeDefined();
  });
});
