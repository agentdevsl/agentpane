import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '@/app/components/features/new-project-dialog';
import type { Result } from '@/lib/utils/result';
import type { PathValidation } from '@/services/codespace.service';

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

const createValidPathResult = (
  overrides: Partial<PathValidation> = {}
): Result<PathValidation, unknown> => ({
  ok: true,
  value: {
    name: overrides.name ?? 'my-project',
    path: overrides.path ?? '/Users/name/workspace/my-project',
    hasClaudeConfig: overrides.hasClaudeConfig ?? false,
    defaultBranch: overrides.defaultBranch ?? 'main',
    remoteUrl: overrides.remoteUrl,
  },
});

const createInvalidPathResult = (): Result<PathValidation, unknown> => ({
  ok: false,
  error: { code: 'NOT_A_GIT_REPO', message: 'Path must point to a valid git repository.' },
});

describe('NewProjectDialog', () => {
  it('renders the dialog with path field and tabs', () => {
    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={vi.fn()}
        recentRepos={[]}
      />
    );

    expect(screen.getByRole('heading', { name: /Add Repository/i })).toBeInTheDocument();
    expect(
      screen.getByText('Connect a local repository or clone from GitHub to start using AgentPane.')
    ).toBeInTheDocument();
    // Check for tabs
    expect(screen.getByRole('tab', { name: /Local Repository/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Clone from URL/i })).toBeInTheDocument();
    // Check for path input via data-testid
    expect(screen.getByTestId('project-path-input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Repository' })).toBeInTheDocument();
  });

  it('validates path on blur and shows check icon for valid path', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn().mockResolvedValue(createValidPathResult());

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/my-project');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalledWith('/Users/name/workspace/my-project');
    });

    await waitFor(() => {
      expect(screen.getByText('Default branch: main')).toBeInTheDocument();
    });

    // Check for success icon via data-testid
    expect(screen.getByTestId('validation-success')).toBeInTheDocument();
  });

  it('validates path on blur and shows warning icon for invalid path', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn().mockResolvedValue(createInvalidPathResult());

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/invalid/path');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalledWith('/invalid/path');
    });

    await waitFor(() => {
      expect(screen.getByText('Path must point to a valid git repository.')).toBeInTheDocument();
    });

    // Check for error icon via data-testid
    expect(screen.getByTestId('validation-error')).toBeInTheDocument();
  });

  it('shows validating message while validating', async () => {
    const user = userEvent.setup();
    let resolveValidation: (value: Result<PathValidation, unknown>) => void;
    const validationPromise = new Promise<Result<PathValidation, unknown>>((resolve) => {
      resolveValidation = resolve;
    });
    const onValidatePath = vi.fn().mockReturnValue(validationPromise);

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/repo');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText('Validating repository...')).toBeInTheDocument();
    });

    resolveValidation?.(createValidPathResult());

    await waitFor(() => {
      expect(screen.queryByText('Validating repository...')).not.toBeInTheDocument();
    });
  });

  it('disables submit when path is not valid', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn().mockResolvedValue(createInvalidPathResult());

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/invalid/path');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalled();
    });

    const submitButton = screen.getByRole('button', { name: 'Add Repository' });
    expect(submitButton).toBeDisabled();
  });

  it('disables submit when name is empty even if path is valid', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn().mockResolvedValue(createValidPathResult({ name: '' }));

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/repo');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalled();
    });

    // Wait for path to be validated - name field only appears after valid path
    await waitFor(() => {
      expect(screen.getByTestId('project-name-input')).toBeInTheDocument();
    });

    const submitButton = screen.getByRole('button', { name: 'Add Repository' });
    expect(submitButton).toBeDisabled();
  });

  it('auto-fills name from path validation result', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi
      .fn()
      .mockResolvedValue(createValidPathResult({ name: 'auto-filled-name' }));

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/auto-filled-name');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalled();
    });

    // Wait for name field to appear (only shown after valid path)
    await waitFor(() => {
      expect(screen.getByTestId('project-name-input')).toBeInTheDocument();
    });

    const nameInput = screen.getByTestId('project-name-input');
    await waitFor(() => {
      expect(nameInput).toHaveValue('auto-filled-name');
    });
  });

  it('does not auto-fill name if user already entered a name', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi
      .fn()
      .mockResolvedValue(createValidPathResult({ name: 'auto-filled-name' }));

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    // First validate path to show name field
    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/repo');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByTestId('project-name-input')).toBeInTheDocument();
    });

    // Now enter a custom name
    const nameInput = screen.getByTestId('project-name-input');
    await user.clear(nameInput);
    await user.type(nameInput, 'My Custom Name');

    // Modify the path to trigger re-validation
    await user.clear(pathInput);
    await user.type(pathInput, '/Users/name/workspace/different-repo');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalledTimes(2);
    });

    // Name should retain user's custom value
    expect(nameInput).toHaveValue('My Custom Name');
  });

  it('calls onSubmit with project data', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const onOpenChange = vi.fn();
    const onValidatePath = vi
      .fn()
      .mockResolvedValue(createValidPathResult({ name: 'my-project', defaultBranch: 'main' }));

    render(
      <NewProjectDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/my-project');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalled();
    });

    // Wait for description field to appear (only shown after valid path)
    await waitFor(() => {
      expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
    });

    const descriptionInput = screen.getByLabelText(/Description/i);
    await user.type(descriptionInput, 'A test project description');

    const submitButton = screen.getByRole('button', { name: 'Add Repository' });
    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await user.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'my-project',
        path: '/Users/name/workspace/my-project',
        description: 'A test project description',
        sandboxType: 'docker',
      });
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('calls onSubmit without description when description is empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const onValidatePath = vi.fn().mockResolvedValue(createValidPathResult({ name: 'my-project' }));

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/my-project');
    await user.tab();

    await waitFor(() => {
      expect(onValidatePath).toHaveBeenCalled();
    });

    const submitButton = screen.getByRole('button', { name: 'Add Repository' });
    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await user.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'my-project',
        path: '/Users/name/workspace/my-project',
        description: undefined,
        sandboxType: 'docker',
      });
    });
  });

  it('closes dialog when cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <NewProjectDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onValidatePath={vi.fn()}
        recentRepos={[]}
      />
    );

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('resets form state when dialog closes', async () => {
    const onValidatePath = vi.fn().mockResolvedValue(createValidPathResult());
    const { rerender } = render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const user = userEvent.setup();
    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/repo');

    rerender(
      <NewProjectDialog
        open={false}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    rerender(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const newPathInput = screen.getByTestId('project-path-input');
    expect(newPathInput).toHaveValue('');
  });

  it('does not validate empty path on blur', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn();

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.click(pathInput);
    await user.tab();

    expect(onValidatePath).not.toHaveBeenCalled();
  });

  it('clears path status when user types in path field', async () => {
    const user = userEvent.setup();
    const onValidatePath = vi.fn().mockResolvedValue(createValidPathResult());

    render(
      <NewProjectDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onValidatePath={onValidatePath}
        recentRepos={[]}
      />
    );

    const pathInput = screen.getByTestId('project-path-input');
    await user.type(pathInput, '/Users/name/workspace/repo');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText('Default branch: main')).toBeInTheDocument();
    });

    await user.type(pathInput, '/new');

    await waitFor(() => {
      expect(screen.queryByText('Default branch: main')).not.toBeInTheDocument();
    });
  });

  describe('Tab switching', () => {
    it('switches to Clone tab when clicked', async () => {
      const user = userEvent.setup();

      render(
        <NewProjectDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onValidatePath={vi.fn()}
          recentRepos={[]}
        />
      );

      // Click the Clone tab
      const cloneTab = screen.getByRole('tab', { name: /Clone from URL/i });
      await user.click(cloneTab);

      // Check that Clone tab content is visible
      expect(screen.getByTestId('clone-url-input')).toBeInTheDocument();
      expect(screen.getByTestId('clone-path-input')).toBeInTheDocument();
    });

    it('validates clone URL format', async () => {
      const user = userEvent.setup();

      render(
        <NewProjectDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onValidatePath={vi.fn()}
          recentRepos={[]}
        />
      );

      // Switch to Clone tab
      const cloneTab = screen.getByRole('tab', { name: /Clone from URL/i });
      await user.click(cloneTab);

      const cloneUrlInput = screen.getByTestId('clone-url-input');
      await user.type(cloneUrlInput, 'invalid-url');

      await waitFor(() => {
        expect(screen.getByText('Please enter a valid GitHub repository URL')).toBeInTheDocument();
      });
    });
  });

  describe('Recent repos', () => {
    it('shows recent repos when provided', () => {
      const recentRepos = [
        { name: 'test-repo', path: '/Users/name/git/test-repo' },
        { name: 'another-repo', path: '/Users/name/git/another-repo' },
      ];

      render(
        <NewProjectDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onValidatePath={vi.fn()}
          recentRepos={recentRepos}
        />
      );

      expect(screen.getByTestId('recent-repos-list')).toBeInTheDocument();
      expect(screen.getByTestId('recent-repo-test-repo')).toBeInTheDocument();
      expect(screen.getByTestId('recent-repo-another-repo')).toBeInTheDocument();
    });

    it('selects recent repo and validates path', async () => {
      const user = userEvent.setup();
      const onValidatePath = vi
        .fn()
        .mockResolvedValue(createValidPathResult({ name: 'test-repo' }));
      const recentRepos = [{ name: 'test-repo', path: '/Users/name/git/test-repo' }];

      render(
        <NewProjectDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onValidatePath={onValidatePath}
          recentRepos={recentRepos}
        />
      );

      const recentRepoButton = screen.getByTestId('recent-repo-test-repo');
      await user.click(recentRepoButton);

      await waitFor(() => {
        expect(onValidatePath).toHaveBeenCalledWith('/Users/name/git/test-repo');
      });

      const pathInput = screen.getByTestId('project-path-input');
      expect(pathInput).toHaveValue('/Users/name/git/test-repo');
    });
  });
});
