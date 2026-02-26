import type { Icon } from '@phosphor-icons/react';
import {
  CircleNotch,
  Eye,
  EyeSlash,
  GithubLogo,
  Key,
  LockKey,
  Shield,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { apiClient } from '@/lib/api/client';
import { isValidPATFormat } from '@/lib/crypto/token-encryption';

export const Route = createFileRoute('/settings/api-keys')({
  component: ApiKeysSettingsPage,
});

// ============================================================================
// KeyInputCard Component (internal card pattern from model-optimizations)
// ============================================================================

function KeyInputCard({
  icon: IconComponent,
  title,
  description,
  placeholder,
  value,
  onChange,
  onSave,
  onClear,
  savedValue,
  showValue,
  onToggleShow,
  isSaving,
  error,
  testIdInput,
  testIdToggle,
  testIdSave,
  testIdRemove,
  children,
}: {
  icon: Icon;
  title: string;
  description: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  savedValue: string | null;
  showValue: boolean;
  onToggleShow: () => void;
  isSaving: boolean;
  error: string | null;
  testIdInput?: string;
  testIdToggle?: string;
  testIdSave?: string;
  testIdRemove?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 transition-all hover:border-border">
      {/* Card header */}
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
          <IconComponent className="h-4 w-4 text-fg-muted" weight="duotone" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
        </div>
      </div>

      {/* Additional content (e.g., permissions list) */}
      {children}

      {/* Saved state or input */}
      {savedValue ? (
        <div
          data-testid={testIdInput ? `${testIdInput.replace('-input', '-configured')}` : undefined}
          className="flex items-center gap-3 rounded-lg border border-border/50 bg-surface/50 p-3"
        >
          <code className="flex-1 font-mono text-sm text-fg">{savedValue}</code>
          <Button data-testid={testIdRemove} variant="ghost" size="sm" onClick={onClear}>
            <Trash className="h-4 w-4" />
            Remove
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <input
              data-testid={testIdInput}
              type={showValue ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 pr-12 font-mono text-sm text-fg placeholder:text-fg-subtle transition-all focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
            <button
              data-testid={testIdToggle}
              type="button"
              onClick={onToggleShow}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-emphasis hover:text-fg"
            >
              {showValue ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <Warning className="h-3.5 w-3.5" />
              {error}
            </p>
          )}

          <Button
            data-testid={testIdSave}
            onClick={onSave}
            disabled={isSaving || !value.trim()}
            size="sm"
          >
            {isSaving ? (
              <>
                <CircleNotch className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Key'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

function ApiKeysSettingsPage(): React.JSX.Element {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [savedAnthropicKey, setSavedAnthropicKey] = useState<string | null>(null);
  const [isSavingAnthropic, setIsSavingAnthropic] = useState(false);
  const [anthropicError, setAnthropicError] = useState<string | null>(null);

  const [githubPat, setGithubPat] = useState('');
  const [showGithubPat, setShowGithubPat] = useState(false);
  const [savedGithubPat, setSavedGithubPat] = useState<string | null>(null);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [isSavingGithub, setIsSavingGithub] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);

  // Load saved keys on mount
  useEffect(() => {
    const loadAnthropicKey = async () => {
      const result = await apiClient.apiKeys.get('anthropic');
      if (result.ok && result.data.keyInfo) {
        setSavedAnthropicKey(result.data.keyInfo.maskedKey);
      }
    };
    loadAnthropicKey();

    const loadGitHubToken = async () => {
      const result = await apiClient.github.getTokenInfo();
      if (result.ok && result.data.tokenInfo) {
        setSavedGithubPat(result.data.tokenInfo.maskedToken);
        setGithubLogin(result.data.tokenInfo.githubLogin);
      }
    };
    loadGitHubToken();
  }, []);

  const handleSaveAnthropicKey = async () => {
    if (!anthropicKey.trim()) return;

    setAnthropicError(null);
    setIsSavingAnthropic(true);

    try {
      const result = await apiClient.apiKeys.save('anthropic', anthropicKey);

      if (!result.ok) {
        setAnthropicError(result.error.message);
        return;
      }

      setSavedAnthropicKey(result.data.keyInfo.maskedKey);
      setAnthropicKey('');
    } catch {
      setAnthropicError('Failed to save key');
    } finally {
      setIsSavingAnthropic(false);
    }
  };

  const handleClearAnthropicKey = async () => {
    try {
      await apiClient.apiKeys.delete('anthropic');
      setSavedAnthropicKey(null);
    } catch {
      // Silently handle error
    }
  };

  const handleSaveGithubPat = async () => {
    if (!githubPat.trim()) return;

    if (!isValidPATFormat(githubPat)) {
      setGithubError('Invalid PAT format. Must start with ghp_ or github_pat_');
      return;
    }

    setGithubError(null);
    setIsSavingGithub(true);

    try {
      const result = await apiClient.github.saveToken(githubPat);

      if (!result.ok) {
        setGithubError(result.error.message);
        return;
      }

      setSavedGithubPat(result.data.tokenInfo.maskedToken);
      setGithubLogin(result.data.tokenInfo.githubLogin);
      setGithubPat('');
    } catch {
      setGithubError('Failed to save PAT');
    } finally {
      setIsSavingGithub(false);
    }
  };

  const handleClearGithubPat = async () => {
    try {
      await apiClient.github.deleteToken();
      setSavedGithubPat(null);
      setGithubLogin(null);
    } catch {
      // Silently handle error
    }
  };

  const configuredCount = [savedAnthropicKey, savedGithubPat].filter(Boolean).length;

  return (
    <div data-testid="api-keys-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header with gradient accent */}
      <header className="relative mb-10">
        {/* Decorative background elements */}
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20">
              <LockKey className="h-6 w-6 text-accent" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">API Keys</h1>
              <p className="text-sm text-fg-muted">
                Securely configure API keys for external services
              </p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{configuredCount}</span> of 2 configured
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-success" />
              <span className="text-xs text-fg-muted">AES-256-GCM encrypted</span>
            </div>
            {githubLogin && (
              <div className="flex items-center gap-2">
                <GithubLogo className="h-4 w-4 text-fg-subtle" weight="fill" />
                <span className="text-xs text-fg-muted">
                  <span className="font-medium text-fg">@{githubLogin}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="space-y-5">
        {/* Anthropic API Key Section */}
        <ConfigSection
          icon={Key}
          title="Anthropic API Key"
          description="Required for running Claude agents on tasks"
          badge="Required"
          badgeColor="claude"
          testId="anthropic-key-section"
        >
          <KeyInputCard
            icon={Key}
            title="API Key"
            description={
              <>
                Get your API key from{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  console.anthropic.com
                </a>
              </>
            }
            placeholder="sk-ant-..."
            value={anthropicKey}
            onChange={setAnthropicKey}
            onSave={handleSaveAnthropicKey}
            onClear={handleClearAnthropicKey}
            savedValue={savedAnthropicKey}
            showValue={showAnthropicKey}
            onToggleShow={() => setShowAnthropicKey(!showAnthropicKey)}
            isSaving={isSavingAnthropic}
            error={anthropicError}
            testIdInput="anthropic-key-input"
            testIdToggle="anthropic-key-toggle"
            testIdSave="save-anthropic-key"
            testIdRemove="remove-anthropic-key"
          />
        </ConfigSection>

        {/* GitHub PAT Section */}
        <ConfigSection
          icon={GithubLogo}
          title="GitHub Personal Access Token"
          description="Optional - enables private repos and organization access"
          badge="Optional"
          badgeColor="accent"
          testId="github-pat-section"
        >
          <KeyInputCard
            icon={GithubLogo}
            title="Personal Access Token"
            description={
              <>
                Generate a{' '}
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  fine-grained PAT
                </a>{' '}
                with repository access
              </>
            }
            placeholder="ghp_... or github_pat_..."
            value={githubPat}
            onChange={setGithubPat}
            onSave={handleSaveGithubPat}
            onClear={handleClearGithubPat}
            savedValue={savedGithubPat}
            showValue={showGithubPat}
            onToggleShow={() => setShowGithubPat(!showGithubPat)}
            isSaving={isSavingGithub}
            error={githubError}
            testIdInput="github-pat-input"
            testIdToggle="github-pat-toggle"
            testIdSave="save-github-pat"
            testIdRemove="remove-github-pat"
          >
            {/* Required permissions */}
            <div className="mb-4 rounded-lg border border-border/50 bg-surface/50 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                Required Permissions
              </p>
              <ul className="space-y-1 text-xs text-fg-muted">
                <li>
                  <strong className="text-fg">Repository access:</strong> All or select specific
                </li>
                <li>
                  <strong className="text-fg">Contents:</strong> Read-only
                </li>
                <li>
                  <strong className="text-fg">Metadata:</strong> Read-only
                </li>
              </ul>
            </div>
          </KeyInputCard>
        </ConfigSection>

        {/* Security Notice */}
        <div
          data-testid="security-notice"
          className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 transition-all hover:border-border"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
              <Shield className="h-4 w-4 text-fg-muted" weight="duotone" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-fg">Security Information</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                All keys are encrypted using AES-256-GCM and stored locally. Keys never leave your
                machine and are not sent to external servers.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
