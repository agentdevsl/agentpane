import type { Icon } from '@phosphor-icons/react';
import {
  ArrowSquareOut,
  Check,
  CircleNotch,
  GitBranch,
  GithubLogo,
  GitPullRequest,
  Key,
  LockKey,
} from '@phosphor-icons/react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { cn } from '@/lib/utils/cn';

export const Route = createFileRoute('/settings/github')({
  component: GitHubSettingsPage,
});

// ============================================================================
// FeatureCard Component (internal card pattern from model-optimizations)
// ============================================================================

function FeatureCard({
  icon: IconComponent,
  title,
  description,
}: {
  icon: Icon;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-4 transition-all hover:border-border">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
          <IconComponent className="h-4 w-4 text-fg-muted" weight="duotone" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

function GitHubSettingsPage(): React.JSX.Element {
  const [hasGitHubToken, setHasGitHubToken] = useState<boolean | null>(null);

  // Check if GitHub PAT is configured
  useEffect(() => {
    const checkToken = async () => {
      try {
        const savedToken = localStorage.getItem('github_pat');
        setHasGitHubToken(!!savedToken);
      } catch {
        setHasGitHubToken(false);
      }
    };
    checkToken();
  }, []);

  // Loading state
  if (hasGitHubToken === null) {
    return (
      <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
        <div className="flex items-center justify-center py-12">
          <CircleNotch className="h-8 w-8 animate-spin text-fg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header with gradient accent */}
      <header className="relative mb-10">
        {/* Decorative background elements */}
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20">
              <GithubLogo className="h-6 w-6 text-accent" weight="fill" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">GitHub Integration</h1>
              <p className="text-sm text-fg-muted">
                Connect to GitHub for repository access and pull requests
              </p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <LockKey className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                Status:{' '}
                <span
                  className={cn('font-medium', hasGitHubToken ? 'text-success' : 'text-attention')}
                >
                  {hasGitHubToken ? 'Connected' : 'Not Connected'}
                </span>
              </span>
            </div>
            {hasGitHubToken && (
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-success" weight="bold" />
                <span className="text-xs text-fg-muted">PAT Configured</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div data-testid={hasGitHubToken ? 'github-connected' : 'github-not-connected'}>
        <div data-testid="github-connection-status" className="text-xs text-fg-muted">
          {hasGitHubToken ? 'Connected' : 'Not connected'}
        </div>

        {!hasGitHubToken ? (
          <div className="space-y-5">
            {/* Setup Required */}
            <ConfigSection
              icon={Key}
              title="Setup Required"
              description="Configure a GitHub Personal Access Token to enable integration"
              badge="Required"
              badgeColor="claude"
            >
              <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-attention-muted">
                  <Key className="h-6 w-6 text-attention" weight="duotone" />
                </div>
                <p className="font-medium text-fg">GitHub Token Required</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
                  Configure a GitHub Personal Access Token in API Keys settings to enable GitHub
                  integration.
                </p>
                <Link to="/settings/api-keys">
                  <Button className="mt-4">
                    <Key className="h-4 w-4" />
                    Configure API Keys
                  </Button>
                </Link>
                <p className="mt-4 text-xs text-fg-subtle">
                  Need help?{' '}
                  <a
                    href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    Learn how to create a GitHub PAT
                    <ArrowSquareOut className="h-3 w-3" />
                  </a>
                </p>
              </div>
            </ConfigSection>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Connection Status */}
            <ConfigSection
              icon={Check}
              title="Connection Status"
              description="Your GitHub Personal Access Token is configured"
              badge="Active"
              badgeColor="success"
            >
              <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-success-muted">
                      <Check className="h-4 w-4 text-success" weight="bold" />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-fg">GitHub PAT Configured</h3>
                      <p className="text-xs text-fg-muted">
                        Your token is ready to use for GitHub operations
                      </p>
                    </div>
                  </div>
                  <Link to="/settings/api-keys">
                    <Button variant="outline" size="sm">
                      Manage Token
                    </Button>
                  </Link>
                </div>
              </div>
            </ConfigSection>

            {/* Available Features */}
            <ConfigSection
              icon={GithubLogo}
              title="Available Features"
              description="What you can do with GitHub integration"
              badge="Features"
              badgeColor="accent"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <FeatureCard
                  icon={GitBranch}
                  title="Clone Private Repositories"
                  description="Access and clone your private repos directly"
                />
                <FeatureCard
                  icon={GitPullRequest}
                  title="Create Pull Requests"
                  description="Generate PRs from agent code changes"
                />
                <FeatureCard
                  icon={GithubLogo}
                  title="Sync Configuration"
                  description="Import settings from your repositories"
                />
                <FeatureCard
                  icon={LockKey}
                  title="Organization Access"
                  description="Work with org repos (if token has access)"
                />
              </div>
            </ConfigSection>
          </div>
        )}
      </div>
    </div>
  );
}
