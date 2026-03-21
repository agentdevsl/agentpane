import {
  Book,
  CheckCircle,
  GithubLogo,
  Lock,
  MagnifyingGlass,
  Plus,
  Spinner,
  Star,
} from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { TextInput } from '@/app/components/ui/text-input';
import { Textarea } from '@/app/components/ui/textarea';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

// Types
export type CreateTemplateInput = {
  name: string;
  description?: string;
  scope: 'org' | 'codespace';
  githubUrl: string;
  branch?: string;
  configPath?: string;
  /** Codespace IDs to associate with this template (for codespace-scoped templates) */
  codespaceIds?: string[];
};

interface ProjectOption {
  id: string;
  name: string;
}

interface AddTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: 'org' | 'codespace';
  /** Initial project IDs to pre-select (for codespace-scoped templates) */
  initialProjectIds?: string[];
  /** Available projects for codespace-scoped templates. Required when scope='codespace'. */
  projects?: ProjectOption[];
  onSubmit: (data: CreateTemplateInput) => Promise<void>;
  onFetchOrgs?: () => Promise<GitHubOrg[]>;
  onFetchReposForOwner?: (owner: string) => Promise<GitHubRepo[]>;
  isGitHubConfigured?: boolean;
}

/**
 * Normalizes GitHub URL to a consistent format.
 * Accepts: "owner/repo", "github.com/owner/repo", "https://github.com/owner/repo"
 * Returns the normalized URL or null if invalid.
 */
function normalizeGitHubUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pattern: owner/repo (e.g., "anthropics/claude-code")
  const shortPattern = /^[\w.-]+\/[\w.-]+$/;
  if (shortPattern.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }

  // Pattern: github.com/owner/repo (missing protocol)
  const noProtocolPattern = /^github\.com\/([\w.-]+)\/([\w.-]+)(\.git)?$/;
  const noProtocolMatch = trimmed.match(noProtocolPattern);
  if (noProtocolMatch) {
    return `https://github.com/${noProtocolMatch[1]}/${noProtocolMatch[2]}`;
  }

  // Pattern: https://github.com/owner/repo or https://github.com/owner/repo.git
  const fullPattern = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(\.git)?$/;
  const fullMatch = trimmed.match(fullPattern);
  if (fullMatch) {
    return `https://github.com/${fullMatch[1]}/${fullMatch[2]}`;
  }

  return null;
}

/**
 * Validates if the input can be normalized to a valid GitHub URL.
 */
function isValidGitHubUrl(input: string): boolean {
  return normalizeGitHubUrl(input) !== null;
}

// Sub-component: GitHubRepoSelector
interface GitHubRepoSelectorProps {
  orgs: GitHubOrg[];
  isLoadingOrgs: boolean;
  onFetchReposForOwner: (owner: string) => Promise<GitHubRepo[]>;
  onSelect: (repo: GitHubRepo) => void;
  selectedRepoId?: number;
}

function GitHubRepoSelector({
  orgs,
  isLoadingOrgs,
  onFetchReposForOwner,
  onSelect,
  selectedRepoId,
}: GitHubRepoSelectorProps) {
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch repos when owner changes
  useWatchEffect(() => {
    if (!selectedOwner) {
      setRepos([]);
      return;
    }

    const fetchRepos = async () => {
      setIsLoadingRepos(true);
      try {
        const fetchedRepos = await onFetchReposForOwner(selectedOwner);
        setRepos(fetchedRepos);
      } catch {
        setRepos([]);
      } finally {
        setIsLoadingRepos(false);
      }
    };

    void fetchRepos();
  }, [selectedOwner, onFetchReposForOwner]);

  // Filter repos by search term
  const filteredRepos = repos.filter((repo) => {
    return (
      repo.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      repo.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (repo.description?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false)
    );
  });

  return (
    <div className="space-y-3" data-testid="github-repo-selector">
      {/* Organization/Owner Selector */}
      <div className="space-y-2">
        <label
          className="text-xs font-medium uppercase tracking-wide text-fg-muted"
          htmlFor="owner-filter"
        >
          Select Organization / Account
        </label>
        {isLoadingOrgs ? (
          <div className="flex items-center gap-2 py-2">
            <Spinner className="h-4 w-4 animate-spin text-fg-muted" />
            <span className="text-sm text-fg-muted">Loading organizations...</span>
          </div>
        ) : orgs.length === 0 ? (
          <div className="py-2 text-sm text-fg-muted">
            No organizations found. Make sure GitHub is configured.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {orgs.map((org) => (
              <button
                key={org.login}
                type="button"
                onClick={() => setSelectedOwner(org.login)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  selectedOwner === org.login
                    ? 'bg-accent text-fg-on-emphasis'
                    : 'bg-surface-subtle text-fg-muted hover:bg-surface-muted hover:text-fg'
                )}
                data-testid={`owner-filter-${org.login}`}
              >
                <img src={org.avatar_url} alt={org.login} className="h-4 w-4 rounded-full" />
                {org.login}
                {org.type === 'user' && <span className="text-fg-subtle">(you)</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Repository Search (only shown when an org is selected) */}
      {selectedOwner && (
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            htmlFor="repo-search"
          >
            Search repositories
          </label>
          <div className="relative mt-2">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <TextInput
              id="repo-search"
              value={searchTerm}
              placeholder="Filter repositories..."
              className="pl-10"
              onChange={(e) => setSearchTerm(e.target.value)}
              data-testid="repo-search-input"
            />
          </div>
        </div>
      )}

      {/* Repository List */}
      {!selectedOwner ? (
        <div className="py-6 text-center text-sm text-fg-muted">
          Select an organization or account above to view repositories.
        </div>
      ) : isLoadingRepos ? (
        <div className="flex items-center justify-center py-6">
          <Spinner className="h-6 w-6 animate-spin text-fg-muted" />
          <span className="ml-2 text-sm text-fg-muted">Loading repositories...</span>
        </div>
      ) : filteredRepos.length === 0 ? (
        <div className="py-6 text-center text-sm text-fg-muted">
          {searchTerm ? 'No repositories match your search.' : 'No repositories found.'}
        </div>
      ) : (
        <div className="max-h-[200px] space-y-1 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface-subtle p-1">
          {filteredRepos.map((repo) => (
            <button
              key={repo.id}
              type="button"
              onClick={() => onSelect(repo)}
              className={cn(
                'flex w-full items-start gap-3 rounded-[var(--radius-sm)] p-2.5',
                'text-left transition-all duration-fast ease-out',
                selectedRepoId === repo.id
                  ? 'border border-accent bg-accent-muted'
                  : 'border border-transparent hover:bg-surface-muted'
              )}
              data-testid={`github-repo-${repo.name}`}
            >
              <div
                className={cn(
                  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius)]',
                  selectedRepoId === repo.id
                    ? 'bg-accent text-fg-on-emphasis'
                    : 'bg-surface-muted text-fg-muted'
                )}
              >
                <Book className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{repo.name}</span>
                  <div className="flex items-center gap-1 text-xs text-fg-subtle">
                    <Star className="h-3 w-3" />
                    {repo.stargazers_count}
                  </div>
                  {repo.private && (
                    <span className="flex items-center gap-0.5 rounded-full bg-surface-muted px-1.5 py-0.5 text-xs text-fg-subtle">
                      <Lock className="h-2.5 w-2.5" weight="fill" />
                      Private
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-fg-subtle">
                  {repo.description || 'No description'}
                </div>
              </div>
              {selectedRepoId === repo.id && (
                <CheckCircle className="h-5 w-5 flex-shrink-0 text-accent" weight="fill" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddTemplateDialog({
  open,
  onOpenChange,
  scope,
  initialProjectIds = [],
  projects = [],
  onSubmit,
  onFetchOrgs,
  onFetchReposForOwner,
  isGitHubConfigured = false,
}: AddTemplateDialogProps): React.JSX.Element {
  const normalizedInitialIds = initialProjectIds;

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(normalizedInitialIds);

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showManualUrl, setShowManualUrl] = useState(false);

  // GitHub state
  const [githubOrgs, setGithubOrgs] = useState<GitHubOrg[]>([]);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [hasFetchedOrgs, setHasFetchedOrgs] = useState(false);

  // Validation state
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Validation helpers
  const nameError = touched.name && !name.trim() ? 'Name is required' : '';
  const githubUrlError =
    touched.githubUrl && !isValidGitHubUrl(githubUrl)
      ? 'Please enter a valid GitHub repository (e.g., owner/repo or https://github.com/owner/repo)'
      : '';
  const projectError =
    scope === 'codespace' && touched.project && selectedProjectIds.length === 0
      ? 'Please select at least one project'
      : '';

  // For project-scoped templates, require at least one project selection
  const needsProjectSelection = scope === 'codespace';
  const hasValidProject = !needsProjectSelection || selectedProjectIds.length > 0;

  const canSubmit = name.trim() && isValidGitHubUrl(githubUrl) && hasValidProject && !isSubmitting;

  // Fetch GitHub orgs when dialog opens
  const fetchGitHubOrgs = useCallback(async () => {
    if (!onFetchOrgs || !isGitHubConfigured || hasFetchedOrgs) return;

    setIsLoadingOrgs(true);
    try {
      const orgs = await onFetchOrgs();
      setGithubOrgs(orgs);
      setHasFetchedOrgs(true);
    } catch {
      setGithubOrgs([]);
    } finally {
      setIsLoadingOrgs(false);
    }
  }, [onFetchOrgs, isGitHubConfigured, hasFetchedOrgs]);

  // Fetch orgs when dialog opens and GitHub is configured
  useWatchEffect(() => {
    if (open && isGitHubConfigured && !hasFetchedOrgs) {
      void fetchGitHubOrgs();
    }
  }, [open, isGitHubConfigured, hasFetchedOrgs, fetchGitHubOrgs]);

  // Callback to fetch repos for a specific owner
  const handleFetchReposForOwner = useCallback(
    async (owner: string): Promise<GitHubRepo[]> => {
      if (!onFetchReposForOwner) return [];
      try {
        return await onFetchReposForOwner(owner);
      } catch {
        return [];
      }
    },
    [onFetchReposForOwner]
  );

  // Handle selecting a GitHub repo
  const handleSelectGitHubRepo = (repo: GitHubRepo): void => {
    setSelectedRepo(repo);
    setGithubUrl(repo.clone_url);
    // Auto-populate name from repo name if not already set
    if (!name.trim()) {
      setName(repo.name);
    }
    setError('');
  };

  // Reset form when dialog closes
  const handleOpenChange = (newOpen: boolean): void => {
    if (!newOpen) {
      // Reset state when closing
      setName('');
      setDescription('');
      setGithubUrl('');
      setBranch('');
      setConfigPath('');
      setSelectedProjectIds(normalizedInitialIds);
      setIsSubmitting(false);
      setError('');
      setTouched({});
      setShowManualUrl(false);
      setGithubOrgs([]);
      setIsLoadingOrgs(false);
      setSelectedRepo(null);
      setHasFetchedOrgs(false);
    }
    onOpenChange(newOpen);
  };

  // Handle field blur for validation
  const handleBlur = (field: string): void => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  // Handle form submission
  const handleSubmit = async (): Promise<void> => {
    // Mark all fields as touched for validation
    setTouched({ name: true, githubUrl: true, project: true });

    if (!canSubmit) return;

    setIsSubmitting(true);
    setError('');

    try {
      const normalizedUrl = normalizeGitHubUrl(githubUrl);
      if (!normalizedUrl) {
        setError('Invalid GitHub URL');
        setIsSubmitting(false);
        return;
      }

      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        scope,
        githubUrl: normalizedUrl,
        branch: branch.trim() || undefined,
        configPath: configPath.trim() || undefined,
        codespaceIds: scope === 'codespace' ? selectedProjectIds : undefined,
      });

      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add template');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg" data-testid="add-template-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-fg-muted" />
            Add Template
          </DialogTitle>
          <DialogDescription>
            Add a template from a GitHub repository.
            {scope === 'codespace'
              ? ' This template will only be available for this project.'
              : ' This template will be available for all projects in your organization.'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="mt-4 space-y-4"
        >
          {/* GitHub Repository Browser (when GitHub is configured) */}
          {isGitHubConfigured && !showManualUrl && onFetchOrgs && onFetchReposForOwner && (
            <>
              <GitHubRepoSelector
                orgs={githubOrgs}
                isLoadingOrgs={isLoadingOrgs}
                onFetchReposForOwner={handleFetchReposForOwner}
                onSelect={handleSelectGitHubRepo}
                selectedRepoId={selectedRepo?.id}
              />

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs uppercase tracking-wide text-fg-subtle">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <button
                type="button"
                onClick={() => setShowManualUrl(true)}
                className="w-full text-center text-sm text-fg-muted hover:text-fg transition-colors"
                data-testid="show-manual-url-button"
              >
                Enter a repository URL manually
              </button>
            </>
          )}

          {/* Manual URL Input (when GitHub is not configured, or user chooses to enter manually) */}
          {(!isGitHubConfigured || showManualUrl || !onFetchOrgs || !onFetchReposForOwner) && (
            <>
              {showManualUrl && isGitHubConfigured && (
                <button
                  type="button"
                  onClick={() => {
                    setShowManualUrl(false);
                    setGithubUrl(selectedRepo?.clone_url ?? '');
                  }}
                  className="text-sm text-accent hover:text-accent/80 transition-colors"
                  data-testid="back-to-repo-list-button"
                >
                  ← Back to repository list
                </button>
              )}

              {/* GitHub URL field */}
              <div className="space-y-2">
                <label
                  htmlFor="template-github-url"
                  className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                >
                  GitHub Repository <span className="text-danger">*</span>
                </label>
                <div className="relative">
                  <GithubLogo className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
                  <TextInput
                    id="template-github-url"
                    value={githubUrl}
                    placeholder="owner/repo or https://github.com/owner/repo"
                    className="pl-10"
                    onChange={(e) => {
                      setGithubUrl(e.target.value);
                      setSelectedRepo(null);
                    }}
                    onBlur={() => handleBlur('githubUrl')}
                    data-testid="template-github-url-input"
                  />
                </div>
                {githubUrlError && (
                  <p className="text-xs text-danger" data-testid="github-url-error">
                    {githubUrlError}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Project selector (for project-scoped templates) */}
          {needsProjectSelection && (
            <div className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Projects <span className="text-danger">*</span>
                <span className="ml-1 font-normal text-fg-subtle">(select one or more)</span>
              </span>
              {projects.length === 0 ? (
                <div className="py-2 text-sm text-fg-muted">
                  No projects available. Create a project first.
                </div>
              ) : (
                <div
                  className="max-h-[160px] space-y-1 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface-subtle p-2"
                  data-testid="template-project-list"
                >
                  {projects.map((project) => {
                    const isSelected = selectedProjectIds.includes(project.id);
                    return (
                      <label
                        key={project.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] p-2 transition-colors',
                          isSelected
                            ? 'bg-accent-muted border border-accent'
                            : 'border border-transparent hover:bg-surface-muted'
                        )}
                        data-testid={`template-project-${project.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedProjectIds((prev) => [...prev, project.id]);
                            } else {
                              setSelectedProjectIds((prev) =>
                                prev.filter((id) => id !== project.id)
                              );
                            }
                          }}
                          className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
                        />
                        <span className="text-sm text-fg">{project.name}</span>
                        {isSelected && (
                          <CheckCircle className="ml-auto h-4 w-4 text-accent" weight="fill" />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedProjectIds.length > 0 && (
                <p className="text-xs text-fg-muted">
                  {selectedProjectIds.length} project{selectedProjectIds.length !== 1 ? 's' : ''}{' '}
                  selected
                </p>
              )}
              {projectError && (
                <p className="text-xs text-danger" data-testid="project-error">
                  {projectError}
                </p>
              )}
            </div>
          )}

          {/* Name field */}
          <div className="space-y-2">
            <label
              htmlFor="template-name"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Name <span className="text-danger">*</span>
            </label>
            <TextInput
              id="template-name"
              value={name}
              placeholder="My Template"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => handleBlur('name')}
              data-testid="template-name-input"
            />
            {nameError && (
              <p className="text-xs text-danger" data-testid="name-error">
                {nameError}
              </p>
            )}
          </div>

          {/* Description field */}
          <div className="space-y-2">
            <label
              htmlFor="template-description"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Description <span className="text-fg-subtle">(optional)</span>
            </label>
            <Textarea
              id="template-description"
              value={description}
              placeholder="A brief description of what this template provides..."
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="template-description-input"
            />
          </div>

          {/* Branch field */}
          <div className="space-y-2">
            <label
              htmlFor="template-branch"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Branch{' '}
              <span className="text-fg-subtle">(optional, defaults to &quot;main&quot;)</span>
            </label>
            <TextInput
              id="template-branch"
              value={branch}
              placeholder="main"
              onChange={(e) => setBranch(e.target.value)}
              data-testid="template-branch-input"
            />
          </div>

          {/* Config Path field */}
          <div className="space-y-2">
            <label
              htmlFor="template-config-path"
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
            >
              Config Path{' '}
              <span className="text-fg-subtle">(optional, defaults to &quot;.claude&quot;)</span>
            </label>
            <TextInput
              id="template-config-path"
              value={configPath}
              placeholder=".claude"
              className="font-mono"
              onChange={(e) => setConfigPath(e.target.value)}
              data-testid="template-config-path-input"
            />
          </div>

          {/* Error message */}
          {error && (
            <div
              className="rounded-md border border-danger/40 bg-danger-muted p-3 text-sm text-danger"
              data-testid="submit-error"
            >
              {error}
            </div>
          )}
        </form>

        <DialogFooter className="mt-6">
          <Button
            variant="outline"
            type="button"
            onClick={() => handleOpenChange(false)}
            data-testid="cancel-button"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            data-testid="add-template-button"
          >
            {isSubmitting ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Add Template
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
