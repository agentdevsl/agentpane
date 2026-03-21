import {
  Book,
  CheckCircle,
  Code,
  CopySimple,
  FolderSimple,
  GitBranch,
  GithubLogo,
  Hexagon,
  Lightning,
  Lock,
  MagnifyingGlass,
  Spinner,
  Star,
  WarningCircle,
} from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { useCallback, useState } from 'react';
import { FolderIcon } from '@/app/components/features/folder-rail/folder-icon';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { TextInput } from '@/app/components/ui/text-input';
import { Textarea } from '@/app/components/ui/textarea';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { useFolderData } from '@/app/providers/folder-context';
import type { SANDBOX_TYPES } from '@/db/schema/shared/enums';
import { cn } from '@/lib/utils/cn';
import type { Result } from '@/lib/utils/result';
import type { PathValidation } from '@/services/codespace.service';
import type { GitHubRepo } from '@/services/github-token.service';

// Types
interface RepositoryInfo {
  name: string;
  path: string;
  isGitRepo: boolean;
  defaultBranch?: string;
  remoteUrl?: string;
  hasClaudeConfig?: boolean;
}

interface RecentRepo {
  name: string;
  path: string;
}

interface SkillConfig {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  enabled: boolean;
}

type SourceType = 'local' | 'clone';

export type SandboxType = (typeof SANDBOX_TYPES)[number];

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    name: string;
    path: string;
    description?: string;
    sandboxType?: SandboxType;
    projectFolderId?: string;
  }) => Promise<Result<void, { code: string; message: string }>>;
  onValidatePath: (path: string) => Promise<Result<PathValidation, unknown>>;
  onClone?: (url: string, destination: string) => Promise<Result<{ path: string }, unknown>>;
  onCreateFromTemplate?: (params: {
    templateOwner: string;
    templateRepo: string;
    name: string;
    owner?: string;
    description?: string;
    isPrivate?: boolean;
    clonePath: string;
  }) => Promise<Result<{ path: string }, unknown>>;
  onFetchOrgs?: () => Promise<GitHubOrg[]>;
  onFetchReposForOwner?: (owner: string) => Promise<GitHubRepo[]>;
  isGitHubConfigured?: boolean;
  recentRepos?: RecentRepo[];
  initialPath?: string;
  initialSource?: SourceType;
  defaultSandboxType?: SandboxType;
}

// Variants for RepoInfoCard
const repoInfoCardVariants = cva(
  'mt-4 rounded-[var(--radius)] border p-4 transition-colors duration-fast ease-out',
  {
    variants: {
      status: {
        valid: 'border-success/40 bg-success-muted',
        invalid: 'border-danger/40 bg-danger-muted',
        idle: 'border-border bg-surface-subtle',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

// Variants for skill cards
const skillCardVariants = cva(
  'flex items-start gap-3 rounded-[var(--radius)] border p-3 transition-all duration-fast ease-out cursor-pointer',
  {
    variants: {
      enabled: {
        true: 'border-accent bg-accent-muted',
        false: 'border-border bg-surface-subtle hover:border-fg-subtle',
      },
    },
    defaultVariants: {
      enabled: false,
    },
  }
);

// Sub-component: RepoInfoCard
interface RepoInfoCardProps extends VariantProps<typeof repoInfoCardVariants> {
  repoInfo: RepositoryInfo | null;
  isValidating?: boolean;
}

function RepoInfoCard({ repoInfo, status, isValidating }: RepoInfoCardProps) {
  if (!repoInfo && !isValidating) return null;

  if (isValidating) {
    return (
      <div className={repoInfoCardVariants({ status: 'idle' })}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-surface-muted text-fg-muted">
            <Spinner className="h-5 w-5 animate-spin" />
          </div>
          <div>
            <div className="text-sm font-medium text-fg">Validating repository...</div>
            <div className="font-mono text-xs text-fg-muted">Checking git configuration</div>
          </div>
        </div>
      </div>
    );
  }

  if (!repoInfo) return null;

  return (
    <div className={repoInfoCardVariants({ status })} data-testid="repo-info-card">
      <div className="mb-3 flex items-center gap-3">
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-[var(--radius)]',
            status === 'valid' ? 'bg-success text-fg-on-emphasis' : 'bg-surface-muted text-fg-muted'
          )}
        >
          <Book className="h-5 w-5" weight="fill" />
        </div>
        <div>
          <div className="font-semibold text-fg">{repoInfo.name}</div>
          <div className="font-mono text-xs text-fg-muted">{repoInfo.path}</div>
        </div>
      </div>
      <div className="flex gap-4 border-t border-border-muted pt-3">
        {repoInfo.isGitRepo && (
          <div className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle className="h-3.5 w-3.5" weight="fill" />
            Git repository
          </div>
        )}
        {repoInfo.defaultBranch && (
          <div className="flex items-center gap-1.5 text-xs text-fg-muted">
            <GitBranch className="h-3.5 w-3.5" />
            {repoInfo.defaultBranch}
          </div>
        )}
        {repoInfo.remoteUrl && (
          <div className="flex items-center gap-1.5 text-xs text-fg-muted">
            <GithubLogo className="h-3.5 w-3.5" />
            origin
          </div>
        )}
      </div>
    </div>
  );
}

// Sub-component: RecentRepoList
interface RecentRepoListProps {
  repos: RecentRepo[];
  onSelect: (path: string) => void;
}

function RecentRepoList({ repos, onSelect }: RecentRepoListProps) {
  const [searchTerm, setSearchTerm] = useState('');

  if (repos.length === 0) return null;

  const filteredRepos = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      repo.path.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-2" data-testid="recent-repos-list">
      {/* Search input */}
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search local repositories..."
          className="w-full rounded-[var(--radius)] border border-border bg-surface-subtle py-2 pl-10 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          data-testid="local-repo-search"
        />
      </div>

      {/* Repo list */}
      <div className="max-h-[240px] space-y-1 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface-subtle p-1">
        {filteredRepos.length === 0 ? (
          <div className="py-4 text-center text-sm text-fg-muted">
            No repositories match your search.
          </div>
        ) : (
          filteredRepos.map((repo) => (
            <button
              key={repo.path}
              type="button"
              onClick={() => onSelect(repo.path)}
              className={cn(
                'flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-transparent p-2.5',
                'text-left transition-all duration-fast ease-out',
                'hover:border-border hover:bg-surface-muted'
              )}
              data-testid={`recent-repo-${repo.name}`}
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius)] bg-surface-muted text-fg-muted">
                <Book className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{repo.name}</div>
                <div className="truncate font-mono text-xs text-fg-subtle">{repo.path}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// Sub-component: SkillCard
interface SkillCardProps {
  skill: SkillConfig;
  onToggle: (id: string) => void;
}

function SkillCard({ skill, onToggle }: SkillCardProps) {
  return (
    <button
      type="button"
      onClick={() => onToggle(skill.id)}
      className={skillCardVariants({ enabled: skill.enabled })}
      data-testid={`skill-card-${skill.id}`}
    >
      <div
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius)]',
          skill.enabled ? 'bg-accent text-fg-on-emphasis' : 'bg-surface-muted text-fg-muted'
        )}
      >
        {skill.icon}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{skill.name}</span>
          {skill.enabled && <CheckCircle className="h-3.5 w-3.5 text-accent" weight="fill" />}
        </div>
        <div className="text-xs text-fg-muted">{skill.description}</div>
      </div>
    </button>
  );
}

// Sub-component: Divider
function Divider({ text }: { text: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs uppercase tracking-wide text-fg-subtle">{text}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// Organization type for the selector
type GitHubOrg = {
  login: string;
  avatar_url: string;
  type: 'user' | 'org';
};

// Sub-component: GitHubRepoList
interface GitHubRepoListProps {
  orgs: GitHubOrg[];
  isLoadingOrgs: boolean;
  onFetchReposForOwner: (owner: string) => Promise<GitHubRepo[]>;
  onSelect: (repo: GitHubRepo) => void;
  selectedRepoId?: number;
}

function GitHubRepoList({
  orgs,
  isLoadingOrgs,
  onFetchReposForOwner,
  onSelect,
  selectedRepoId,
}: GitHubRepoListProps) {
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showTemplatesOnly, setShowTemplatesOnly] = useState(false);
  const [showPrivateOnly, setShowPrivateOnly] = useState(false);

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

  // Count for filter labels
  const templateCount = repos.filter((repo) => repo.is_template).length;
  const privateCount = repos.filter((repo) => repo.private).length;

  // Filter repos by search term and filters
  const filteredRepos = repos.filter((repo) => {
    // Apply template filter
    if (showTemplatesOnly && !repo.is_template) {
      return false;
    }
    // Apply private filter
    if (showPrivateOnly && !repo.private) {
      return false;
    }
    // Then apply search filter
    return (
      repo.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      repo.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (repo.description?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false)
    );
  });

  return (
    <div className="space-y-3" data-testid="github-repo-list">
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

      {/* Repository Search and Filters (only shown when an org is selected) */}
      {selectedOwner && (
        <>
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

          {/* Filter chips */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Filter:</span>
            <button
              type="button"
              onClick={() => setShowTemplatesOnly(!showTemplatesOnly)}
              disabled={templateCount === 0}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                showTemplatesOnly
                  ? 'bg-accent text-fg-on-emphasis'
                  : templateCount > 0
                    ? 'bg-surface-subtle text-fg-muted hover:bg-surface-muted hover:text-fg'
                    : 'bg-surface-subtle text-fg-subtle cursor-not-allowed opacity-50'
              )}
              data-testid="template-filter-toggle"
            >
              <CopySimple className="h-3.5 w-3.5" />
              Templates ({templateCount})
            </button>
            <button
              type="button"
              onClick={() => setShowPrivateOnly(!showPrivateOnly)}
              disabled={privateCount === 0}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                showPrivateOnly
                  ? 'bg-accent text-fg-on-emphasis'
                  : privateCount > 0
                    ? 'bg-surface-subtle text-fg-muted hover:bg-surface-muted hover:text-fg'
                    : 'bg-surface-subtle text-fg-subtle cursor-not-allowed opacity-50'
              )}
              data-testid="private-filter-toggle"
            >
              <Lock className="h-3.5 w-3.5" />
              Private ({privateCount})
            </button>
          </div>
        </>
      )}

      {/* Repository List */}
      {!selectedOwner ? (
        <div className="py-8 text-center text-sm text-fg-muted">
          Select an organization or account above to view repositories.
        </div>
      ) : isLoadingRepos ? (
        <div className="flex items-center justify-center py-8">
          <Spinner className="h-6 w-6 animate-spin text-fg-muted" />
          <span className="ml-2 text-sm text-fg-muted">Loading repositories...</span>
        </div>
      ) : filteredRepos.length === 0 ? (
        <div className="py-8 text-center text-sm text-fg-muted">
          {searchTerm ? 'No repositories match your search.' : 'No repositories found.'}
        </div>
      ) : (
        <div className="max-h-[240px] space-y-1 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface-subtle p-1">
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
                  {repo.is_template && (
                    <span className="flex items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-xs text-accent">
                      <CopySimple className="h-2.5 w-2.5" weight="fill" />
                      Template
                    </span>
                  )}
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

// Default skills configuration
const defaultSkills: SkillConfig[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    icon: <Code className="h-4 w-4" />,
    description: 'Automated PR reviews and suggestions',
    enabled: true,
  },
  {
    id: 'testing',
    name: 'Testing',
    icon: <Lightning className="h-4 w-4" />,
    description: 'Generate and run test suites',
    enabled: false,
  },
];

// Recent repos - passed in from parent component when available
// TODO: [CQ-018] Implement recent repos discovery via API

export function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  onValidatePath,
  onClone,
  onCreateFromTemplate,
  onFetchOrgs,
  onFetchReposForOwner,
  isGitHubConfigured = false,
  recentRepos = [],
  initialPath = '',
  initialSource = 'local',
  defaultSandboxType = 'docker',
}: NewProjectDialogProps): React.JSX.Element {
  // Folder data
  const { folders, selectedFolderId } = useFolderData();

  // Form state
  const [sourceType, setSourceType] = useState<SourceType>(initialSource);
  const [name, setName] = useState('');
  const [path, setPath] = useState(initialPath);
  const [description, setDescription] = useState('');
  const [sandboxType, setSandboxType] = useState<SandboxType>(defaultSandboxType);
  const [selectedProjectFolderId, setSelectedProjectFolderId] = useState<string>(
    selectedFolderId ?? ''
  );
  const [cloneUrl, setCloneUrl] = useState('');
  const [clonePath, setClonePath] = useState('~/git/');

  // Template-specific state
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoOwner, setNewRepoOwner] = useState<string | undefined>(undefined);
  const [newRepoPrivate, setNewRepoPrivate] = useState(false);

  // Validation state
  const [pathStatus, setPathStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');
  const [pathMessage, setPathMessage] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);

  // Skills state
  const [skills, setSkills] = useState<SkillConfig[]>(defaultSkills);

  // Clone state
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState('');

  // Submit error state (for duplicate path etc.)
  const [submitError, setSubmitError] = useState('');

  // GitHub orgs state
  const [githubOrgs, setGithubOrgs] = useState<GitHubOrg[]>([]);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [showManualUrl, setShowManualUrl] = useState(false);
  const [hasFetchedOrgs, setHasFetchedOrgs] = useState(false);

  // Reset state when dialog closes
  useWatchEffect(() => {
    if (!open) {
      setSourceType(initialSource);
      setName('');
      setPath(initialPath);
      setDescription('');
      setCloneUrl('');
      setClonePath('~/git/');
      setPathStatus('idle');
      setPathMessage('');
      setIsValidating(false);
      setRepoInfo(null);
      setSkills(defaultSkills);
      setIsCloning(false);
      setCloneError('');
      setSubmitError('');
      setSelectedProjectFolderId(selectedFolderId ?? '');
      // Reset GitHub state
      setGithubOrgs([]);
      setIsLoadingOrgs(false);
      setSelectedRepo(null);
      setShowManualUrl(false);
      setHasFetchedOrgs(false);
      // Reset template state
      setNewRepoName('');
      setNewRepoOwner(undefined);
      setNewRepoPrivate(false);
    }
  }, [open, initialPath, initialSource]);

  // Fetch GitHub orgs when clone tab is selected
  const fetchGitHubOrgs = useCallback(async () => {
    if (!onFetchOrgs || !isGitHubConfigured || hasFetchedOrgs) return;

    setIsLoadingOrgs(true);
    try {
      const orgs = await onFetchOrgs();
      setGithubOrgs(orgs);
      setHasFetchedOrgs(true);
    } catch {
      // Silently fail - user can still use manual URL entry
      setGithubOrgs([]);
    } finally {
      setIsLoadingOrgs(false);
    }
  }, [onFetchOrgs, isGitHubConfigured, hasFetchedOrgs]);

  // Fetch orgs when switching to clone tab
  useWatchEffect(() => {
    if (sourceType === 'clone' && isGitHubConfigured && !hasFetchedOrgs) {
      void fetchGitHubOrgs();
    }
  }, [sourceType, isGitHubConfigured, hasFetchedOrgs, fetchGitHubOrgs]);

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
    setCloneUrl(repo.clone_url);
    setCloneError('');
  };

  // Validate path for local repos
  const validatePath = async (pathToValidate?: string): Promise<void> => {
    const targetPath = pathToValidate ?? path;
    if (!targetPath.trim()) {
      setPathStatus('idle');
      setPathMessage('');
      setRepoInfo(null);
      return;
    }

    setIsValidating(true);
    const result = await onValidatePath(targetPath.trim());
    setIsValidating(false);

    if (result.ok) {
      setPathStatus('valid');
      setPathMessage(
        result.value.defaultBranch ? `Default branch: ${result.value.defaultBranch}` : ''
      );
      setRepoInfo({
        name: result.value.name ?? targetPath.split('/').pop() ?? 'unknown',
        path: targetPath,
        isGitRepo: true,
        defaultBranch: result.value.defaultBranch,
        remoteUrl: result.value.remoteUrl,
        hasClaudeConfig: result.value.hasClaudeConfig,
      });
      if (!name.trim()) {
        setName(result.value.name ?? '');
      }
    } else {
      setPathStatus('invalid');
      setPathMessage('Path must point to a valid git repository.');
      setRepoInfo(null);
    }
  };

  // Handle recent repo selection
  const handleSelectRecent = (repoPath: string): void => {
    setPath(repoPath);
    setPathStatus('idle');
    setPathMessage('');
    void validatePath(repoPath);
  };

  // Handle clone URL validation
  const validateCloneUrl = (url: string): boolean => {
    const githubHttpsPattern = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+(\.git)?$/;
    const githubSshPattern = /^git@github\.com:[\w-]+\/[\w.-]+(\.git)?$/;
    return githubHttpsPattern.test(url) || githubSshPattern.test(url);
  };

  // Toggle skill
  const handleToggleSkill = (skillId: string): void => {
    setSkills((prev) =>
      prev.map((skill) => (skill.id === skillId ? { ...skill, enabled: !skill.enabled } : skill))
    );
  };

  // Check if selected repo is a template
  const isTemplateSelected = selectedRepo?.is_template ?? false;

  // Handle form submission
  const handleSubmit = async (): Promise<void> => {
    setSubmitError('');

    if (sourceType === 'clone') {
      setIsCloning(true);
      setCloneError('');

      // Handle template repo differently
      if (isTemplateSelected && onCreateFromTemplate && selectedRepo) {
        const templateResult = await onCreateFromTemplate({
          templateOwner: selectedRepo.owner.login,
          templateRepo: selectedRepo.name,
          name: newRepoName.trim(),
          owner: newRepoOwner,
          description: description.trim() || undefined,
          isPrivate: newRepoPrivate,
          clonePath,
        });

        if (!templateResult.ok) {
          setIsCloning(false);
          const err = templateResult.error as { message?: string; code?: string } | undefined;
          const errorMessage =
            err?.message ||
            'Failed to create repository from template. The name may already exist.';
          setCloneError(errorMessage);
          return;
        }

        const submitResult = await onSubmit({
          name: newRepoName.trim(),
          path: templateResult.value.path,
          description: description.trim() || undefined,
          sandboxType,
          projectFolderId: selectedProjectFolderId || undefined,
        });
        setIsCloning(false);

        if (!submitResult.ok) {
          setSubmitError(submitResult.error.message);
          return;
        }
      } else if (onClone) {
        // Regular clone
        const cloneResult = await onClone(cloneUrl, clonePath);

        if (!cloneResult.ok) {
          setIsCloning(false);
          const err = cloneResult.error as { message?: string; code?: string } | undefined;
          const errorMessage =
            err?.message || 'Failed to clone repository. Please check the URL and try again.';
          setCloneError(errorMessage);
          return;
        }

        const submitResult = await onSubmit({
          name: cloneUrl.split('/').pop()?.replace('.git', '') ?? 'project',
          path: cloneResult.value.path,
          description: description.trim() || undefined,
          sandboxType,
          projectFolderId: selectedProjectFolderId || undefined,
        });
        setIsCloning(false);

        if (!submitResult.ok) {
          setSubmitError(submitResult.error.message);
          return;
        }
      }
    } else {
      const submitResult = await onSubmit({
        name: name.trim(),
        path: path.trim(),
        description: description.trim() || undefined,
        sandboxType,
        projectFolderId: selectedProjectFolderId || undefined,
      });

      if (!submitResult.ok) {
        setSubmitError(submitResult.error.message);
        return;
      }
    }
    onOpenChange(false);
  };

  // Check if form is submittable
  const canSubmitTemplate = isTemplateSelected && newRepoName.trim() && clonePath.trim();
  const canSubmitClone =
    !isTemplateSelected && cloneUrl.trim() && validateCloneUrl(cloneUrl) && clonePath.trim();
  const canSubmit =
    sourceType === 'local'
      ? name.trim() && pathStatus === 'valid'
      : canSubmitTemplate || canSubmitClone;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderSimple className="h-5 w-5 text-fg-muted" />
            Add Repository
          </DialogTitle>
          <DialogDescription>
            Connect a local repository or clone from GitHub to start using AgentPane.
          </DialogDescription>
        </DialogHeader>

        {/* Folder selector */}
        {folders.length > 0 && (
          <div className="mt-4 space-y-2">
            <label
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
              htmlFor="project-folder"
            >
              Folder
            </label>
            <div className="relative">
              <select
                id="project-folder"
                value={selectedProjectFolderId}
                onChange={(e) => setSelectedProjectFolderId(e.target.value)}
                className="w-full appearance-none rounded-[var(--radius)] border border-border bg-surface-subtle px-3 py-2 pl-9 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="project-folder-select"
              >
                <option value="">No folder</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                {selectedProjectFolderId ? (
                  <FolderIcon
                    iconName={
                      folders.find((f) => f.id === selectedProjectFolderId)?.icon ?? 'folder'
                    }
                    size={16}
                  />
                ) : (
                  <FolderSimple className="h-4 w-4 text-fg-subtle" />
                )}
              </div>
            </div>
          </div>
        )}

        <Tabs
          value={sourceType}
          onValueChange={(v) => setSourceType(v as SourceType)}
          className="mt-4"
        >
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="local" className="flex-1 gap-2">
              <FolderSimple className="h-4 w-4" />
              Local Repository
            </TabsTrigger>
            <TabsTrigger value="clone" className="flex-1 gap-2">
              <GithubLogo className="h-4 w-4" />
              Clone from URL
            </TabsTrigger>
          </TabsList>

          {/* Local Repository Tab */}
          <TabsContent value="local" className="space-y-4">
            <div className="space-y-2">
              <label
                className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                htmlFor="project-path"
              >
                Repository Path
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <TextInput
                    id="project-path"
                    value={path}
                    placeholder="/Users/name/workspace/repo"
                    className="font-mono"
                    onChange={(event) => {
                      setPath(event.target.value);
                      setPathStatus('idle');
                      setPathMessage('');
                      setRepoInfo(null);
                    }}
                    onBlur={() => void validatePath()}
                    data-testid="project-path-input"
                  />
                  {pathStatus !== 'idle' && !isValidating && (
                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                      {pathStatus === 'valid' ? (
                        <CheckCircle
                          className="h-4 w-4 text-success"
                          weight="fill"
                          data-testid="validation-success"
                        />
                      ) : (
                        <WarningCircle
                          className="h-4 w-4 text-danger"
                          weight="fill"
                          data-testid="validation-error"
                        />
                      )}
                    </div>
                  )}
                  {isValidating && (
                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                      <Spinner className="h-4 w-4 animate-spin text-fg-muted" />
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void validatePath()}
                  disabled={!path.trim() || isValidating}
                  data-testid="validate-path-button"
                >
                  Validate
                </Button>
              </div>
              {!isValidating && pathMessage && (
                <p
                  className={cn(
                    'text-xs',
                    pathStatus === 'valid' ? 'text-fg-muted' : 'text-danger'
                  )}
                  data-testid="validation-result"
                >
                  {pathMessage}
                </p>
              )}
            </div>

            {/* Repo Info Card */}
            <RepoInfoCard
              repoInfo={repoInfo}
              status={
                pathStatus === 'valid' ? 'valid' : pathStatus === 'invalid' ? 'invalid' : 'idle'
              }
              isValidating={isValidating}
            />

            {/* Recent Repos */}
            {recentRepos.length > 0 && (
              <>
                <Divider text="or select recent" />
                <RecentRepoList repos={recentRepos} onSelect={handleSelectRecent} />
              </>
            )}

            {/* Codespace Name (only shown after valid path) */}
            {pathStatus === 'valid' && (
              <div className="space-y-2">
                <label
                  className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                  htmlFor="project-name"
                >
                  Codespace name
                </label>
                <TextInput
                  id="project-name"
                  value={name}
                  placeholder="AgentPane"
                  onChange={(event) => setName(event.target.value)}
                  data-testid="project-name-input"
                />
              </div>
            )}

            {/* Description (only shown after valid path) */}
            {pathStatus === 'valid' && (
              <div className="space-y-2">
                <label
                  className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                  htmlFor="project-description"
                >
                  Description <span className="text-fg-subtle">(optional)</span>
                </label>
                <Textarea
                  id="project-description"
                  value={description}
                  placeholder="Short summary or goal."
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                />
              </div>
            )}

            {/* Sandbox Type (only shown after valid path) */}
            {pathStatus === 'valid' && (
              <div className="space-y-2">
                <span className="block text-xs font-medium uppercase tracking-wide text-fg-muted">
                  Sandbox Type
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setSandboxType('docker')}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                      sandboxType === 'docker'
                        ? 'border-accent bg-accent-muted/30'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="sandbox-type-docker"
                  >
                    <span className="text-xl">🐳</span>
                    <div>
                      <div className="font-medium text-fg text-sm">Docker</div>
                      <div className="text-xs text-fg-muted">Container isolation</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSandboxType('devcontainer')}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                      sandboxType === 'devcontainer'
                        ? 'border-accent bg-accent-muted/30'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="sandbox-type-devcontainer"
                  >
                    <span className="text-xl">📦</span>
                    <div>
                      <div className="font-medium text-fg text-sm">DevContainer</div>
                      <div className="text-xs text-fg-muted">VS Code integration</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSandboxType('kubernetes')}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                      sandboxType === 'kubernetes'
                        ? 'border-accent bg-accent-muted/30'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="sandbox-type-kubernetes"
                  >
                    <span className="text-xl">☸️</span>
                    <div>
                      <div className="font-medium text-fg text-sm">Kubernetes</div>
                      <div className="text-xs text-fg-muted">Cluster pods</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSandboxType('nomad')}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                      sandboxType === 'nomad'
                        ? 'border-attention bg-attention/10'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="sandbox-type-nomad"
                  >
                    <Hexagon
                      className={cn(
                        'h-5 w-5',
                        sandboxType === 'nomad' ? 'text-attention' : 'text-fg-muted'
                      )}
                      weight={sandboxType === 'nomad' ? 'duotone' : 'regular'}
                    />
                    <div>
                      <div className="font-medium text-fg text-sm">Nomad</div>
                      <div className="text-xs text-fg-muted">Scheduled jobs</div>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Skills Section (only shown after valid path) */}
            {pathStatus === 'valid' && (
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                  Codespace Skills
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {skills.map((skill) => (
                    <SkillCard key={skill.id} skill={skill} onToggle={handleToggleSkill} />
                  ))}
                </div>
              </fieldset>
            )}
          </TabsContent>

          {/* Clone Tab */}
          <TabsContent value="clone" className="space-y-4">
            {/* GitHub Repository Browser (when GitHub is configured) */}
            {isGitHubConfigured && !showManualUrl && (
              <>
                <GitHubRepoList
                  orgs={githubOrgs}
                  isLoadingOrgs={isLoadingOrgs}
                  onFetchReposForOwner={handleFetchReposForOwner}
                  onSelect={handleSelectGitHubRepo}
                  selectedRepoId={selectedRepo?.id}
                />

                {/* Template-specific fields (shown when a template is selected) */}
                {isTemplateSelected && selectedRepo && (
                  <div className="space-y-4 rounded-lg border border-accent/30 bg-accent-muted/30 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-accent">
                      <CopySimple className="h-4 w-4" weight="fill" />
                      Creating new repository from template: {selectedRepo.name}
                    </div>

                    <div className="space-y-2">
                      <label
                        className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                        htmlFor="new-repo-name"
                      >
                        New Repository Name
                      </label>
                      <TextInput
                        id="new-repo-name"
                        value={newRepoName}
                        placeholder="my-new-project"
                        onChange={(e) => setNewRepoName(e.target.value)}
                        data-testid="new-repo-name-input"
                      />
                    </div>

                    <div className="space-y-2">
                      <label
                        className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                        htmlFor="new-repo-owner"
                      >
                        Owner
                      </label>
                      <select
                        id="new-repo-owner"
                        value={newRepoOwner ?? ''}
                        onChange={(e) => setNewRepoOwner(e.target.value || undefined)}
                        className="w-full rounded-[var(--radius)] border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                        data-testid="new-repo-owner-select"
                      >
                        <option value="">Your account</option>
                        {githubOrgs
                          .filter((org) => org.type === 'org')
                          .map((org) => (
                            <option key={org.login} value={org.login}>
                              {org.login}
                            </option>
                          ))}
                      </select>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-fg-muted">
                      <input
                        type="checkbox"
                        checked={newRepoPrivate}
                        onChange={(e) => setNewRepoPrivate(e.target.checked)}
                        className="rounded border-border"
                        data-testid="new-repo-private-checkbox"
                      />
                      <Lock className="h-3.5 w-3.5" />
                      Make repository private
                    </label>
                  </div>
                )}

                {!isTemplateSelected && (
                  <>
                    <Divider text="or enter URL manually" />

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
              </>
            )}

            {/* Manual URL Input (when GitHub is not configured, or user chooses to enter manually) */}
            {(!isGitHubConfigured || showManualUrl) && (
              <>
                {showManualUrl && isGitHubConfigured && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowManualUrl(false);
                      setCloneUrl(selectedRepo?.clone_url ?? '');
                    }}
                    className="text-sm text-accent hover:text-accent/80 transition-colors"
                    data-testid="back-to-repo-list-button"
                  >
                    ← Back to repository list
                  </button>
                )}

                <div className="space-y-2">
                  <label
                    className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                    htmlFor="clone-url"
                  >
                    Repository URL
                  </label>
                  <div className="relative">
                    <GithubLogo className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
                    <TextInput
                      id="clone-url"
                      value={cloneUrl}
                      placeholder="https://github.com/owner/repo"
                      className="pl-10"
                      onChange={(event) => {
                        setCloneUrl(event.target.value);
                        setCloneError('');
                        setSelectedRepo(null);
                      }}
                      data-testid="clone-url-input"
                    />
                    {cloneUrl && (
                      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                        {validateCloneUrl(cloneUrl) ? (
                          <CheckCircle className="h-4 w-4 text-success" weight="fill" />
                        ) : (
                          <WarningCircle className="h-4 w-4 text-danger" weight="fill" />
                        )}
                      </div>
                    )}
                  </div>
                  {cloneUrl && !validateCloneUrl(cloneUrl) && (
                    <p className="text-xs text-danger">
                      Please enter a valid GitHub repository URL
                    </p>
                  )}
                </div>
              </>
            )}

            {/* Clone path (always shown) */}
            <div className="space-y-2">
              <label
                className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                htmlFor="clone-path"
              >
                Clone to
              </label>
              <div className="flex gap-2">
                <TextInput
                  id="clone-path"
                  value={clonePath}
                  placeholder="~/git/"
                  className="flex-1 font-mono"
                  onChange={(event) => setClonePath(event.target.value)}
                  data-testid="clone-path-input"
                />
                <Button variant="outline" type="button">
                  Browse...
                </Button>
              </div>
            </div>

            {cloneError && (
              <div className="rounded-[var(--radius)] border border-danger/40 bg-danger-muted p-3 text-sm text-danger">
                {cloneError}
              </div>
            )}

            {/* Description for clone */}
            <div className="space-y-2">
              <label
                className="text-xs font-medium uppercase tracking-wide text-fg-muted"
                htmlFor="clone-description"
              >
                Description <span className="text-fg-subtle">(optional)</span>
              </label>
              <Textarea
                id="clone-description"
                value={description}
                placeholder="Short summary or goal."
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>

            {/* Sandbox Type for clone */}
            <div className="space-y-2">
              <span className="block text-xs font-medium uppercase tracking-wide text-fg-muted">
                Sandbox Type
              </span>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSandboxType('docker')}
                  className={cn(
                    'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                    sandboxType === 'docker'
                      ? 'border-accent bg-accent-muted/30'
                      : 'border-border hover:border-fg-subtle'
                  )}
                  data-testid="clone-sandbox-type-docker"
                >
                  <span className="text-xl">🐳</span>
                  <div>
                    <div className="font-medium text-fg text-sm">Docker</div>
                    <div className="text-xs text-fg-muted">Container isolation</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSandboxType('devcontainer')}
                  className={cn(
                    'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                    sandboxType === 'devcontainer'
                      ? 'border-accent bg-accent-muted/30'
                      : 'border-border hover:border-fg-subtle'
                  )}
                  data-testid="clone-sandbox-type-devcontainer"
                >
                  <span className="text-xl">📦</span>
                  <div>
                    <div className="font-medium text-fg text-sm">DevContainer</div>
                    <div className="text-xs text-fg-muted">VS Code integration</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSandboxType('kubernetes')}
                  className={cn(
                    'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                    sandboxType === 'kubernetes'
                      ? 'border-accent bg-accent-muted/30'
                      : 'border-border hover:border-fg-subtle'
                  )}
                  data-testid="clone-sandbox-type-kubernetes"
                >
                  <span className="text-xl">☸️</span>
                  <div>
                    <div className="font-medium text-fg text-sm">Kubernetes</div>
                    <div className="text-xs text-fg-muted">Cluster pods</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSandboxType('nomad')}
                  className={cn(
                    'flex items-center gap-3 rounded-[var(--radius)] border-2 p-3 text-left transition-colors',
                    sandboxType === 'nomad'
                      ? 'border-attention bg-attention/10'
                      : 'border-border hover:border-fg-subtle'
                  )}
                  data-testid="clone-sandbox-type-nomad"
                >
                  <Hexagon
                    className={cn(
                      'h-5 w-5',
                      sandboxType === 'nomad' ? 'text-attention' : 'text-fg-muted'
                    )}
                    weight={sandboxType === 'nomad' ? 'duotone' : 'regular'}
                  />
                  <div>
                    <div className="font-medium text-fg text-sm">Nomad</div>
                    <div className="text-xs text-fg-muted">Scheduled jobs</div>
                  </div>
                </button>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Submit error display */}
        {submitError && (
          <div
            className="mt-4 flex items-start gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning-muted p-3"
            data-testid="submit-error"
          >
            <WarningCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" weight="fill" />
            <div className="text-sm text-warning">{submitError}</div>
          </div>
        )}

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || isCloning}
            data-testid="create-project-button"
          >
            {isCloning ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Cloning...
              </>
            ) : (
              <>
                <FolderSimple className="h-4 w-4" />
                Add Repository
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
