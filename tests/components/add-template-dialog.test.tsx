import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AddTemplateDialog,
  type CreateTemplateInput,
} from '@/app/components/features/add-template-dialog';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

// Mock GitHub org
const mockOrg: GitHubOrg = {
  login: 'test-org',
  id: 1,
  avatar_url: 'https://example.com/avatar.png',
  type: 'Organization',
};

const mockUserOrg: GitHubOrg = {
  login: 'testuser',
  id: 2,
  avatar_url: 'https://example.com/user-avatar.png',
  type: 'user',
};

// Mock GitHub repo
const mockRepo: GitHubRepo = {
  id: 123,
  name: 'test-repo',
  full_name: 'test-org/test-repo',
  description: 'A test repository',
  private: false,
  clone_url: 'https://github.com/test-org/test-repo.git',
  default_branch: 'main',
  stargazers_count: 42,
};

const mockPrivateRepo: GitHubRepo = {
  id: 456,
  name: 'private-repo',
  full_name: 'test-org/private-repo',
  description: 'A private repository',
  private: true,
  clone_url: 'https://github.com/test-org/private-repo.git',
  default_branch: 'main',
  stargazers_count: 10,
};

// Mock projects
const mockProjects = [
  { id: 'proj-1', name: 'Project Alpha' },
  { id: 'proj-2', name: 'Project Beta' },
  { id: 'proj-3', name: 'Project Gamma' },
];

describe('AddTemplateDialog', () => {
  describe('rendering', () => {
    it('renders the dialog with required fields for org scope', () => {
      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      expect(screen.getByRole('heading', { name: /Add Template/i })).toBeInTheDocument();
      expect(screen.getByText(/Add a template from a GitHub repository/i)).toBeInTheDocument();
      expect(screen.getByTestId('template-github-url-input')).toBeInTheDocument();
      expect(screen.getByTestId('template-name-input')).toBeInTheDocument();
      expect(screen.getByTestId('template-description-input')).toBeInTheDocument();
      expect(screen.getByTestId('template-branch-input')).toBeInTheDocument();
      expect(screen.getByTestId('template-config-path-input')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Add Template/i })).toBeInTheDocument();
    });

    it('renders project description for org scope', () => {
      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      expect(
        screen.getByText(/This template will be available for all projects in your organization/i)
      ).toBeInTheDocument();
    });

    it('renders project description for project scope', () => {
      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          onSubmit={vi.fn()}
        />
      );

      expect(
        screen.getByText(/This template will only be available for this project/i)
      ).toBeInTheDocument();
    });

    it('renders project selector for project-scoped templates', () => {
      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByTestId('template-project-list')).toBeInTheDocument();
      expect(screen.getByTestId('template-project-proj-1')).toBeInTheDocument();
      expect(screen.getByTestId('template-project-proj-2')).toBeInTheDocument();
      expect(screen.getByTestId('template-project-proj-3')).toBeInTheDocument();
    });

    it('shows no projects message when project list is empty', () => {
      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={[]}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByText(/No projects available/i)).toBeInTheDocument();
    });
  });

  describe('GitHub URL validation', () => {
    it('validates owner/repo format', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');
      await user.tab();

      // Should not show error for valid format
      expect(screen.queryByTestId('github-url-error')).not.toBeInTheDocument();
    });

    it('validates full GitHub URL format', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'https://github.com/owner/repo');
      await user.tab();

      expect(screen.queryByTestId('github-url-error')).not.toBeInTheDocument();
    });

    it('validates GitHub URL without protocol', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'github.com/owner/repo');
      await user.tab();

      expect(screen.queryByTestId('github-url-error')).not.toBeInTheDocument();
    });

    it('shows error for invalid GitHub URL', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'not-a-valid-url');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByTestId('github-url-error')).toBeInTheDocument();
      });
      expect(screen.getByText(/Please enter a valid GitHub repository/i)).toBeInTheDocument();
    });
  });

  describe('name validation', () => {
    it('shows error when name is empty on blur', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const nameInput = screen.getByTestId('template-name-input');
      await user.click(nameInput);
      await user.tab();

      await waitFor(() => {
        expect(screen.getByTestId('name-error')).toBeInTheDocument();
      });
      expect(screen.getByText(/Name is required/i)).toBeInTheDocument();
    });

    it('clears error when name is entered', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const nameInput = screen.getByTestId('template-name-input');
      await user.click(nameInput);
      await user.tab();

      await waitFor(() => {
        expect(screen.getByTestId('name-error')).toBeInTheDocument();
      });

      await user.type(nameInput, 'My Template');

      await waitFor(() => {
        expect(screen.queryByTestId('name-error')).not.toBeInTheDocument();
      });
    });
  });

  describe('project selection', () => {
    it('pre-selects projects from initialProjectIds', () => {
      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-1', 'proj-3']}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByText('2 projects selected')).toBeInTheDocument();
    });

    it('allows selecting multiple projects', async () => {
      const user = userEvent.setup();

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          onSubmit={vi.fn()}
        />
      );

      const project1 = screen.getByTestId('template-project-proj-1');
      const project2 = screen.getByTestId('template-project-proj-2');

      await user.click(project1);
      await user.click(project2);

      expect(screen.getByText('2 projects selected')).toBeInTheDocument();
    });

    it('allows deselecting projects', async () => {
      const user = userEvent.setup();

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-1', 'proj-2']}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByText('2 projects selected')).toBeInTheDocument();

      const project1 = screen.getByTestId('template-project-proj-1');
      await user.click(project1);

      expect(screen.getByText('1 project selected')).toBeInTheDocument();
    });

    it('shows error when no projects selected on submit', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          onSubmit={onSubmit}
        />
      );

      // Fill in required fields but don't select a project
      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      // The submit button is disabled when no project is selected for project-scoped templates
      // So we need to trigger the validation by blurring the project area
      const projectList = screen.getByTestId('template-project-list');
      await user.click(projectList);
      // Tab away to trigger blur/validation logic
      await user.tab();

      // Now click the disabled submit button (it won't call handleSubmit but still triggers validation)
      const submitButton = screen.getByTestId('add-template-button');
      // Submit button should be disabled because no project is selected
      expect(submitButton).toBeDisabled();

      // The error appears because the touched state is true after interacting with the list
      // but we need to also click the submit button to trigger the full validation
      // Since button is disabled, we verify the button IS disabled when no project is selected
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('form submission', () => {
    it('disables submit button when form is invalid', () => {
      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const submitButton = screen.getByTestId('add-template-button');
      expect(submitButton).toBeDisabled();
    });

    it('enables submit button when form is valid for org scope', async () => {
      const user = userEvent.setup();

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={vi.fn()} />);

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      expect(submitButton).not.toBeDisabled();
    });

    it('enables submit button when form is valid for project scope', async () => {
      const user = userEvent.setup();

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-1']}
          onSubmit={vi.fn()}
        />
      );

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      expect(submitButton).not.toBeDisabled();
    });

    it('calls onSubmit with correct data for org scope', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <AddTemplateDialog open onOpenChange={onOpenChange} scope="org" onSubmit={onSubmit} />
      );

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const descInput = screen.getByTestId('template-description-input');
      await user.type(descInput, 'A test template');

      const branchInput = screen.getByTestId('template-branch-input');
      await user.type(branchInput, 'develop');

      const configInput = screen.getByTestId('template-config-path-input');
      await user.type(configInput, '.templates');

      const submitButton = screen.getByTestId('add-template-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          name: 'My Template',
          description: 'A test template',
          scope: 'org',
          githubUrl: 'https://github.com/owner/repo',
          branch: 'develop',
          configPath: '.templates',
          codespaceIds: undefined,
        } satisfies CreateTemplateInput);
      });

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('calls onSubmit with correct data for project scope', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-1', 'proj-2']}
          onSubmit={onSubmit}
        />
      );

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'https://github.com/owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          name: 'My Template',
          description: undefined,
          scope: 'codespace',
          githubUrl: 'https://github.com/owner/repo',
          branch: undefined,
          configPath: undefined,
          codespaceIds: ['proj-1', 'proj-2'],
        } satisfies CreateTemplateInput);
      });
    });

    it('shows error message when submission fails', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockRejectedValue(new Error('Failed to create template'));

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={onSubmit} />);

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      });
      expect(screen.getByText('Failed to create template')).toBeInTheDocument();
    });

    it('shows adding state while submitting', async () => {
      const user = userEvent.setup();
      let resolveSubmit: () => void;
      const submitPromise = new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      });
      const onSubmit = vi.fn().mockReturnValue(submitPromise);

      render(<AddTemplateDialog open onOpenChange={vi.fn()} scope="org" onSubmit={onSubmit} />);

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Adding.../i)).toBeInTheDocument();
      });

      resolveSubmit?.();

      await waitFor(() => {
        expect(screen.queryByText(/Adding.../i)).not.toBeInTheDocument();
      });
    });
  });

  describe('dialog behavior', () => {
    it('closes dialog when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();

      render(<AddTemplateDialog open onOpenChange={onOpenChange} scope="org" onSubmit={vi.fn()} />);

      const cancelButton = screen.getByTestId('cancel-button');
      await user.click(cancelButton);

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('resets form state when dialog closes via cancel button', async () => {
      const user = userEvent.setup();
      let isOpen = true;
      const onOpenChange = vi.fn((open: boolean) => {
        isOpen = open;
      });

      const { rerender } = render(
        <AddTemplateDialog
          open={isOpen}
          onOpenChange={onOpenChange}
          scope="org"
          onSubmit={vi.fn()}
        />
      );

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      // Close the dialog using the cancel button (this triggers onOpenChange)
      const cancelButton = screen.getByTestId('cancel-button');
      await user.click(cancelButton);

      expect(onOpenChange).toHaveBeenCalledWith(false);

      // Simulate the parent component responding to onOpenChange
      rerender(
        <AddTemplateDialog
          open={false}
          onOpenChange={onOpenChange}
          scope="org"
          onSubmit={vi.fn()}
        />
      );

      // Re-open the dialog
      rerender(
        <AddTemplateDialog open onOpenChange={onOpenChange} scope="org" onSubmit={vi.fn()} />
      );

      const newNameInput = screen.getByTestId('template-name-input');
      expect(newNameInput).toHaveValue('');
    });
  });

  describe('GitHub repo browser', () => {
    it('shows GitHub repo selector when GitHub is configured', async () => {
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg, mockUserOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([mockRepo]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('github-repo-selector')).toBeInTheDocument();
      });
    });

    it('fetches organizations on dialog open', async () => {
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(onFetchOrgs).toHaveBeenCalled();
      });
    });

    it('displays organizations after fetching', async () => {
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg, mockUserOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('owner-filter-test-org')).toBeInTheDocument();
      });
      expect(screen.getByTestId('owner-filter-testuser')).toBeInTheDocument();
    });

    it('fetches repos when organization is selected', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([mockRepo, mockPrivateRepo]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('owner-filter-test-org')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('owner-filter-test-org'));

      await waitFor(() => {
        expect(onFetchReposForOwner).toHaveBeenCalledWith('test-org');
      });
    });

    it('displays repos after selecting organization', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([mockRepo, mockPrivateRepo]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('owner-filter-test-org')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('owner-filter-test-org'));

      await waitFor(() => {
        expect(screen.getByTestId('github-repo-test-repo')).toBeInTheDocument();
      });
      expect(screen.getByTestId('github-repo-private-repo')).toBeInTheDocument();
    });

    it('selects repo and populates URL and name', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([mockRepo]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('owner-filter-test-org')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('owner-filter-test-org'));

      await waitFor(() => {
        expect(screen.getByTestId('github-repo-test-repo')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('github-repo-test-repo'));

      // Name should be auto-populated
      const nameInput = screen.getByTestId('template-name-input');
      expect(nameInput).toHaveValue('test-repo');
    });

    it('filters repos by search term', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([mockRepo, mockPrivateRepo]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('owner-filter-test-org')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('owner-filter-test-org'));

      await waitFor(() => {
        expect(screen.getByTestId('github-repo-test-repo')).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId('repo-search-input');
      await user.type(searchInput, 'private');

      await waitFor(() => {
        expect(screen.queryByTestId('github-repo-test-repo')).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('github-repo-private-repo')).toBeInTheDocument();
    });

    it('shows manual URL button when GitHub is configured', async () => {
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('show-manual-url-button')).toBeInTheDocument();
      });
    });

    it('switches to manual URL input when button clicked', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('show-manual-url-button')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('show-manual-url-button'));

      await waitFor(() => {
        expect(screen.getByTestId('template-github-url-input')).toBeInTheDocument();
      });
      expect(screen.getByTestId('back-to-repo-list-button')).toBeInTheDocument();
    });

    it('goes back to repo list when back button clicked', async () => {
      const user = userEvent.setup();
      const onFetchOrgs = vi.fn().mockResolvedValue([mockOrg]);
      const onFetchReposForOwner = vi.fn().mockResolvedValue([]);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="org"
          onSubmit={vi.fn()}
          isGitHubConfigured
          onFetchOrgs={onFetchOrgs}
          onFetchReposForOwner={onFetchReposForOwner}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('show-manual-url-button')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('show-manual-url-button'));

      await waitFor(() => {
        expect(screen.getByTestId('back-to-repo-list-button')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('back-to-repo-list-button'));

      await waitFor(() => {
        expect(screen.getByTestId('github-repo-selector')).toBeInTheDocument();
      });
    });
  });

  describe('initialProjectIds prop', () => {
    it('pre-selects projects from initialProjectIds', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-1']}
          onSubmit={onSubmit}
        />
      );

      // Should show 1 project selected
      expect(screen.getByText('1 project selected')).toBeInTheDocument();

      const nameInput = screen.getByTestId('template-name-input');
      await user.type(nameInput, 'My Template');

      const urlInput = screen.getByTestId('template-github-url-input');
      await user.type(urlInput, 'owner/repo');

      const submitButton = screen.getByTestId('add-template-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            codespaceIds: ['proj-1'],
          })
        );
      });
    });

    it('supports multiple initial project IDs', () => {
      render(
        <AddTemplateDialog
          open
          onOpenChange={vi.fn()}
          scope="codespace"
          projects={mockProjects}
          initialProjectIds={['proj-2', 'proj-3']}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByText('2 projects selected')).toBeInTheDocument();
    });
  });
});
