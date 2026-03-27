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
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { TextInput } from '@/app/components/ui/text-input';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

export const Route = createFileRoute('/settings/github')({
  component: GitHubSettingsPage,
});

interface Installation {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  teamId: string | null;
  status: string;
  createdAt: string;
}

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

interface AppStatus {
  configured: boolean;
  installUrl: string | null;
  appSlug: string | null;
}

function GitHubSettingsPage(): React.JSX.Element {
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState(
    () =>
      (typeof localStorage !== 'undefined' && localStorage.getItem('agentpane_external_url')) || ''
  );
  const [isCreating, setIsCreating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [manifestData, setManifestData] = useState<{ manifest: string; githubUrl: string } | null>(
    null
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statusRes, installRes] = await Promise.all([
        apiClient.github.app.status(),
        apiClient.github.app.listInstallations(),
      ]);

      if (statusRes.ok) {
        setAppStatus({
          configured: statusRes.data.configured,
          installUrl: statusRes.data.installUrl,
          appSlug: statusRes.data.appSlug,
        });
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
    const params = new URLSearchParams(window.location.search);

    // Handle manifest flow callback (code param from GitHub App creation)
    const code = params.get('code');
    if (code) {
      const url = new URL(window.location.href);
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      window.history.replaceState({}, '', url.pathname);
      handleSetupCallback(code);
      return;
    }

    // Handle installation callback (installation_id from GitHub App install)
    const installationId = params.get('installation_id');
    if (installationId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('installation_id');
      url.searchParams.delete('setup_action');
      window.history.replaceState({}, '', url.pathname);
      registerInstallation(Number(installationId));
      return;
    }

    void loadData();
  });

  const handleSetupCallback = async (code: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.github.app.setupCallback(code);
      if (!res.ok) {
        setError('Failed to complete GitHub App setup');
      }
    } catch {
      setError('Failed to complete GitHub App setup');
    } finally {
      await loadData();
    }
  };

  const registerInstallation = async (installationId: number) => {
    setIsLoading(true);
    try {
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
        await loadData();
      }
    } catch {
      setError('Failed to register installation');
      setIsLoading(false);
    }
  };

  const handleCreateApp = async () => {
    if (!externalUrl.trim()) {
      setError('Please enter your external URL');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Remember the URL
      localStorage.setItem('agentpane_external_url', externalUrl.trim());

      const res = await apiClient.github.app.getManifest(externalUrl.trim());
      if (!res.ok) {
        setError('Failed to generate GitHub App manifest');
        setIsCreating(false);
        return;
      }

      // Set manifest data and submit the form in the next render
      setManifestData({ manifest: res.data.manifest, githubUrl: res.data.githubUrl });
      // Use setTimeout to allow React to render the hidden form before submitting
      setTimeout(() => {
        formRef.current?.submit();
      }, 50);
    } catch {
      setError('Failed to create GitHub App');
      setIsCreating(false);
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

  if (isLoading && appStatus === null) {
    return (
      <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
        <div className="flex items-center justify-center py-12">
          <CircleNotch className="h-8 w-8 animate-spin text-fg-muted" />
        </div>
      </div>
    );
  }

  const isConnected = installations.length > 0;
  const appState = isConnected ? 'installed' : appStatus?.configured ? 'created' : 'not_created';

  return (
    <div data-testid="github-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Hidden form for GitHub App manifest submission */}
      {manifestData && (
        <form
          ref={formRef}
          method="post"
          action={manifestData.githubUrl}
          style={{ display: 'none' }}
        >
          <input type="hidden" name="manifest" value={manifestData.manifest} />
        </form>
      )}

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
                {appState === 'not_created'
                  ? 'Create a GitHub App for automatic webhook delivery'
                  : 'GitHub App integration for webhooks and repository access'}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <LockKey className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                Status:{' '}
                <span
                  className={cn(
                    'font-medium',
                    appState === 'installed'
                      ? 'text-success'
                      : appState === 'created'
                        ? 'text-accent'
                        : 'text-attention'
                  )}
                >
                  {appState === 'installed'
                    ? 'Connected'
                    : appState === 'created'
                      ? 'App Created'
                      : 'Not Configured'}
                </span>
              </span>
            </div>
            {appStatus?.appSlug && (
              <div className="flex items-center gap-2">
                <GithubLogo className="h-4 w-4 text-fg-subtle" />
                <span className="text-xs text-fg-muted">{appStatus.appSlug}</span>
              </div>
            )}
            {isConnected && (
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-success" weight="bold" />
                <span className="text-xs text-fg-muted">
                  {installations.length} installation{installations.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-danger-muted/30 p-4 text-sm text-danger">
          <Warning className="mr-2 inline h-4 w-4" />
          {error}
        </div>
      )}

      {/* State 1: App Not Created */}
      {appState === 'not_created' && (
        <div className="space-y-5">
          <ConfigSection
            icon={GithubLogo}
            title="Create GitHub App"
            description="One-click GitHub App setup with automatic webhook configuration"
            badge="Setup"
            badgeColor="claude"
          >
            <div className="space-y-4 rounded-lg border border-border/70 bg-surface-subtle/30 p-5">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent-muted">
                  <Plugs className="h-6 w-6 text-accent" weight="duotone" />
                </div>
                <p className="font-medium text-fg">Create a GitHub App</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
                  AgentPane will create a GitHub App on your account. Webhooks and permissions are
                  configured automatically.
                </p>
              </div>

              <div>
                <label htmlFor="external-url" className="mb-1.5 block text-sm font-medium text-fg">
                  External URL
                </label>
                <TextInput
                  id="external-url"
                  type="url"
                  placeholder="https://agentpane.example.com"
                  value={externalUrl}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setExternalUrl(e.target.value)
                  }
                />
                <p className="mt-1 text-xs text-fg-muted">
                  The publicly-accessible URL where GitHub will deliver webhooks
                </p>
              </div>

              <div className="flex justify-center">
                <Button onClick={handleCreateApp} disabled={isCreating || !externalUrl.trim()}>
                  {isCreating ? (
                    <>
                      <CircleNotch className="h-4 w-4 animate-spin" />
                      Redirecting to GitHub...
                    </>
                  ) : (
                    <>
                      <GithubLogo className="h-4 w-4" weight="fill" />
                      Create GitHub App
                      <ArrowSquareOut className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </div>

              <div className="rounded-md border border-accent/20 bg-accent-muted/20 p-3">
                <p className="text-xs font-medium text-accent">How it works</p>
                <ol className="mt-2 space-y-1.5 text-xs text-fg-muted">
                  <li className="flex items-start gap-2">
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                      1
                    </span>
                    Click Create to set up a GitHub App on your account — permissions and webhooks
                    are pre-configured
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                      2
                    </span>
                    Install the app on your organization or personal account
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                      3
                    </span>
                    Codespaces linked to GitHub repos automatically receive events
                  </li>
                </ol>
              </div>
            </div>
          </ConfigSection>
        </div>
      )}

      {/* State 2: App Created, Not Installed */}
      {appState === 'created' && (
        <div className="space-y-5">
          <ConfigSection
            icon={Check}
            title="GitHub App Created"
            description={`App "${appStatus?.appSlug ?? 'AgentPane'}" is ready to install`}
            badge="Ready"
            badgeColor="accent"
          >
            <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-success-muted">
                <Check className="h-6 w-6 text-success" weight="bold" />
              </div>
              <p className="font-medium text-fg">App Created Successfully</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">
                Now install the app on your GitHub organization or personal account to start
                receiving events.
              </p>

              {appStatus?.installUrl ? (
                <a href={appStatus?.installUrl ?? '#'} rel="noopener noreferrer">
                  <Button className="mt-4">
                    <GithubLogo className="h-4 w-4" weight="fill" />
                    Install GitHub App
                    <ArrowSquareOut className="h-3.5 w-3.5" />
                  </Button>
                </a>
              ) : (
                <p className="mt-4 text-xs text-attention">Install URL not available</p>
              )}
            </div>
          </ConfigSection>
        </div>
      )}

      {/* State 3: App Installed */}
      {appState === 'installed' && (
        <div className="space-y-5">
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

              {appStatus?.installUrl && (
                <a href={installUrl} rel="noopener noreferrer" className="block">
                  <Button variant="outline" size="sm" className="w-full">
                    <GithubLogo className="h-4 w-4" />
                    Add Another Account
                  </Button>
                </a>
              )}
            </div>
          </ConfigSection>

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
                description="Push, PR, and issue events delivered automatically"
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
                description="Codespaces with GitHub repos get events automatically"
              />
            </div>
          </ConfigSection>
        </div>
      )}
    </div>
  );
}
