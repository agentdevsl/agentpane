import type { Icon } from '@phosphor-icons/react';
import {
  ArrowSquareOut,
  Bell,
  Check,
  CircleNotch,
  GitBranch,
  GithubLogo,
  GitPullRequest,
  Lightning,
  LockKey,
  Plugs,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

export const Route = createFileRoute('/settings/github')({
  component: GitHubSettingsPage,
});

// ============================================================================
// Types
// ============================================================================

interface Installation {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  teamId: string | null;
  status: string;
  createdAt: string;
}

// ============================================================================
// FeatureCard Component
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
  const [appConfigured, setAppConfigured] = useState<boolean | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statusRes, installRes] = await Promise.all([
        apiClient.github.app.status(),
        apiClient.github.app.listInstallations(),
      ]);

      if (statusRes.ok) {
        setAppConfigured(statusRes.data.configured);
        setInstallUrl(statusRes.data.installUrl);
      }

      if (installRes.ok) {
        setInstallations(installRes.data.items);
      }
    } catch {
      setError('Failed to load GitHub App status');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useMountEffect(() => {
    // Check URL for installation_id param (GitHub redirect after install)
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get('installation_id');

    if (installationId) {
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete('installation_id');
      url.searchParams.delete('setup_action');
      window.history.replaceState({}, '', url.pathname);

      // Register the installation
      registerInstallation(Number(installationId));
    }

    void loadData();
  });

  const registerInstallation = async (installationId: number) => {
    setIsLoading(true);
    try {
      // Use first available team — in most setups there's a single team
      const teamsRes = await apiClient.teams.list();
      const teamId = teamsRes.ok ? teamsRes.data.items[0]?.id : null;

      if (!teamId) {
        setError('No team found. Create a team first.');
        setIsLoading(false);
        return;
      }

      const res = await apiClient.github.app.registerInstallation(installationId, teamId);
      if (res.ok) {
        await loadData();
      } else {
        setError('Failed to register installation');
      }
    } catch {
      setError('Failed to register installation');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveInstallation = async (id: string) => {
    try {
      const res = await apiClient.github.app.removeInstallation(id);
      if (res.ok) {
        setInstallations((prev) => prev.filter((i) => i.id !== id));
      } else {
        setError('Failed to remove installation');
      }
    } catch {
      setError('Failed to remove installation');
    }
  };

  if (isLoading && appConfigured === null) {
    return (
      <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
        <div className="flex items-center justify-center py-12">
          <CircleNotch className="h-8 w-8 animate-spin text-fg-muted" />
        </div>
      </div>
    );
  }

  const isConnected = installations.length > 0;

  return (
    <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header */}
      <header className="relative mb-10">
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
                Install the GitHub App for automatic webhook delivery and repository access
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <LockKey className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                Status:{' '}
                <span
                  className={cn('font-medium', isConnected ? 'text-success' : 'text-attention')}
                >
                  {isConnected ? 'Connected' : 'Not Connected'}
                </span>
              </span>
            </div>
            {isConnected && (
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-success" weight="bold" />
                <span className="text-xs text-fg-muted">
                  {installations.length} installation{installations.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            {appConfigured === false && (
              <div className="flex items-center gap-2">
                <Warning className="h-4 w-4 text-attention" weight="bold" />
                <span className="text-xs text-attention">App not configured on server</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div data-testid={isConnected ? 'github-connected' : 'github-not-connected'}>
        {error && (
          <div className="mb-5 rounded-lg border border-danger/30 bg-danger-muted/30 p-4 text-sm text-danger">
            <Warning className="mr-2 inline h-4 w-4" />
            {error}
          </div>
        )}

        {!isConnected ? (
          <div className="space-y-5">
            <ConfigSection
              icon={GithubLogo}
              title="Install GitHub App"
              description="Connect your GitHub organization or account with one click"
              badge="Required"
              badgeColor="claude"
            >
              <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent-muted">
                  <Plugs className="h-6 w-6 text-accent" weight="duotone" />
                </div>
                <p className="font-medium text-fg">Install the AgentPane GitHub App</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
                  The GitHub App automatically delivers webhooks and provides repository access. No
                  manual webhook configuration needed.
                </p>

                {installUrl ? (
                  <a href={installUrl} rel="noopener noreferrer">
                    <Button className="mt-4">
                      <GithubLogo className="h-4 w-4" weight="fill" />
                      Install GitHub App
                      <ArrowSquareOut className="h-3.5 w-3.5" />
                    </Button>
                  </a>
                ) : (
                  <div className="mt-4">
                    <p className="text-xs text-attention">
                      GitHub App is not configured on the server. Set{' '}
                      <code className="rounded bg-surface-muted px-1">GITHUB_APP_NAME</code>,{' '}
                      <code className="rounded bg-surface-muted px-1">GITHUB_APP_ID</code>, and{' '}
                      <code className="rounded bg-surface-muted px-1">GITHUB_PRIVATE_KEY</code>{' '}
                      environment variables.
                    </p>
                  </div>
                )}

                <div className="mt-5 rounded-md border border-accent/20 bg-accent-muted/20 p-3 text-left">
                  <p className="text-xs font-medium text-accent">How it works</p>
                  <ol className="mt-2 space-y-1.5 text-xs text-fg-muted">
                    <li className="flex items-start gap-2">
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                        1
                      </span>
                      Click Install to authorize the app on your GitHub account or organization
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                        2
                      </span>
                      GitHub automatically delivers webhook events (push, PR, issues) to AgentPane
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                        3
                      </span>
                      Codespaces linked to GitHub repos get events configured automatically
                    </li>
                  </ol>
                </div>
              </div>
            </ConfigSection>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Installations */}
            <ConfigSection
              icon={Check}
              title="Connected Accounts"
              description="GitHub App installations linked to this instance"
              badge="Active"
              badgeColor="success"
            >
              <div className="space-y-3">
                {installations.map((inst) => (
                  <div
                    key={inst.id}
                    className="flex items-center justify-between rounded-lg border border-border/70 bg-surface-subtle/30 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-success-muted">
                        <GithubLogo className="h-4 w-4 text-success" weight="fill" />
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-fg">{inst.accountLogin}</h3>
                        <p className="text-xs text-fg-muted">
                          {inst.accountType} · Installed{' '}
                          {new Date(inst.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-success-muted px-2 py-0.5 text-xs font-medium text-success">
                        Active
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveInstallation(inst.id)}
                        className="text-danger hover:bg-danger-muted hover:text-danger"
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}

                {installUrl && (
                  <a href={installUrl} rel="noopener noreferrer" className="block">
                    <Button variant="outline" size="sm" className="w-full">
                      <GithubLogo className="h-4 w-4" />
                      Add Another Account
                    </Button>
                  </a>
                )}
              </div>
            </ConfigSection>

            {/* Features */}
            <ConfigSection
              icon={Lightning}
              title="What's Configured"
              description="Features enabled by the GitHub App integration"
              badge="Features"
              badgeColor="accent"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <FeatureCard
                  icon={Bell}
                  title="Automatic Webhooks"
                  description="Push, PR, and issue events delivered automatically — no manual setup"
                />
                <FeatureCard
                  icon={GitBranch}
                  title="Repository Access"
                  description="Clone and access repos via installation tokens"
                />
                <FeatureCard
                  icon={GitPullRequest}
                  title="Pull Requests"
                  description="Create and manage PRs from agent code changes"
                />
                <FeatureCard
                  icon={Plugs}
                  title="Auto-configured Events"
                  description="New codespaces with GitHub repos get event subscriptions automatically"
                />
              </div>
            </ConfigSection>
          </div>
        )}
      </div>
    </div>
  );
}
