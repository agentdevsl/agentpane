import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSettings } from '@/app/components/features/project-settings';
import type { Codespace as Project, CodespaceConfig as ProjectConfig } from '@/db/schema';

// Mock folder context used by the component
vi.mock('@/app/providers/folder-context', () => ({
  useFolderData: () => ({
    folders: [],
    selectedFolderId: null,
    selectedFolder: null,
    isLoading: false,
    isFolderPanelOpen: false,
    isNavPanelOpen: false,
    folderPanelWidth: 240,
    navPanelWidth: 280,
    selectFolder: vi.fn(),
    toggleFolderPanel: vi.fn(),
    toggleNavPanel: vi.fn(),
    setFolderPanelOpen: vi.fn(),
    setNavPanelOpen: vi.fn(),
    setFolderPanelWidth: vi.fn(),
    setNavPanelWidth: vi.fn(),
    persistFolderPanelWidth: vi.fn(),
    persistNavPanelWidth: vi.fn(),
    refreshFolders: vi.fn(),
  }),
}));

describe('ProjectSettings', () => {
  it('saves updated settings', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const project: Project = {
      id: 'project-1',
      name: 'AgentPane',
      path: '/repo',
      createdAt: new Date(),
      updatedAt: new Date(),
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read'],
        maxTurns: 50,
        model: 'claude-sonnet-4',
      } satisfies ProjectConfig,
      githubOwner: 'agentpane',
      githubRepo: 'agentpane',
      maxConcurrentAgents: 3,
      projectFolderId: 'folder-1',
      sandboxConfigId: null,
      githubInstallationId: null,
      configPath: '.claude',
      description: null,
    };

    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProjectSettings project={project} onSave={onSave} onDelete={onDelete} />);

    fireEvent.change(screen.getByLabelText(/default branch/i), {
      target: { value: 'develop' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(onSave).toHaveBeenCalled();
    const [payload] = onSave.mock.calls[0] ?? [];
    expect(payload).toEqual(
      expect.objectContaining({
        maxConcurrentAgents: 3,
        config: expect.objectContaining({
          defaultBranch: 'develop',
        }),
      })
    );
  });
});
