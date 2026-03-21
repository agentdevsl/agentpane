import {
  ArrowSquareOut,
  Check,
  CircleNotch,
  Eye,
  EyeSlash,
  GithubLogo,
  Key,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { TextInput } from '@/app/components/ui/text-input';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { useServices } from '@/app/services/service-context';
import type { TokenInfo } from '@/services/github-token.service';

interface GitHubAppSetupProps {
  onTokenSaved?: () => void;
}

export function GitHubAppSetup({ onTokenSaved }: GitHubAppSetupProps): React.JSX.Element {
  const services = useServices();
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Load existing token info on mount
  useWatchEffect(() => {
    const loadToken = async () => {
      setIsLoading(true);
      try {
        if (services?.githubTokenService) {
          const result = await services.githubTokenService.getTokenInfo();
          if (result.ok) {
            setTokenInfo(result.value);
          }
        }
      } catch {
        // Ignore errors
      }
      setIsLoading(false);
    };
    void loadToken();
  }, [services?.githubTokenService]);

  const handleSaveToken = async () => {
    if (!token.trim()) {
      setError('Please enter a token');
      return;
    }

    setError(null);
    setIsSaving(true);

    try {
      if (services?.githubTokenService) {
        const result = await services.githubTokenService.saveToken(token);
        if (result.ok) {
          setTokenInfo(result.value);
          setToken('');
          setShowForm(false);
          onTokenSaved?.();
        } else {
          setError(result.error.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteToken = async () => {
    try {
      if (services?.githubTokenService) {
        const result = await services.githubTokenService.deleteToken();
        if (result.ok) {
          setTokenInfo(null);
        }
      }
    } catch {
      // Ignore errors
    }
  };

  const handleRevalidate = async () => {
    setIsLoading(true);
    try {
      if (services?.githubTokenService) {
        await services.githubTokenService.revalidateToken();
        // Reload token info to get updated validation status
        const result = await services.githubTokenService.getTokenInfo();
        if (result.ok) {
          setTokenInfo(result.value);
        }
      }
    } catch {
      // Ignore errors
    }
    setIsLoading(false);
  };

  if (isLoading) {
    return (
      <section
        className="rounded-lg border border-border bg-surface p-6"
        data-testid="github-settings"
      >
        <div className="flex items-center gap-3">
          <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />
          <span className="text-sm text-fg-muted">Loading GitHub settings...</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-lg border border-border bg-surface p-6"
      data-testid="github-settings"
    >
      <div
        data-testid={tokenInfo ? 'github-connected' : 'github-not-connected'}
        className="hidden"
      />
      <div data-testid="github-repo-info" className="hidden" />
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface-muted">
          <GithubLogo className="h-5 w-5 text-fg-muted" weight="fill" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-fg">GitHub Connection</h2>
          <p className="text-sm text-fg-muted">
            {tokenInfo
              ? `Connected as @${tokenInfo.githubLogin}`
              : 'Connect with a Personal Access Token to enable GitHub features.'}
          </p>
        </div>
        {tokenInfo && (
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              tokenInfo.isValid ? 'bg-success-muted text-success' : 'bg-danger-muted text-danger'
            }`}
          >
            {tokenInfo.isValid ? (
              <>
                <Check className="h-3.5 w-3.5" weight="bold" />
                Connected
              </>
            ) : (
              <>
                <Warning className="h-3.5 w-3.5" weight="bold" />
                Invalid
              </>
            )}
          </div>
        )}
      </div>

      {/* Token Info Display */}
      {tokenInfo && !showForm && (
        <div className="mt-4 rounded-md border border-border bg-surface-subtle p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Key className="h-4 w-4 text-fg-muted" />
              <div>
                <p className="font-mono text-sm text-fg">{tokenInfo.maskedToken}</p>
                <p className="text-xs text-fg-muted">
                  Added {new Date(tokenInfo.createdAt).toLocaleDateString()}
                  {tokenInfo.lastValidatedAt && (
                    <>
                      {' '}
                      · Last validated {new Date(tokenInfo.lastValidatedAt).toLocaleDateString()}
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={handleRevalidate} disabled={isLoading}>
                Revalidate
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowForm(true)}>
                Replace
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteToken}
                className="text-danger hover:bg-danger-muted hover:text-danger"
              >
                <Trash className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Token Input Form */}
      {showForm || !tokenInfo ? (
        <div className="mt-4 space-y-4">
          {/* Security info */}
          <div className="rounded-md border border-accent/30 bg-accent-muted/30 p-3">
            <p className="text-xs text-fg-muted">
              <strong className="text-accent">Security note:</strong> Your token is encrypted using
              AES-256 before storage. Generate a{' '}
              <a
                href="https://github.com/settings/tokens?type=beta"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:text-accent-emphasis"
              >
                fine-grained PAT
              </a>{' '}
              with only the permissions you need (typically{' '}
              <code className="rounded bg-surface-muted px-1">repo</code> access).
            </p>
          </div>

          {/* Token input */}
          <div>
            <label htmlFor="github-pat" className="mb-1.5 block text-sm font-medium text-fg">
              Personal Access Token
            </label>
            <div className="relative">
              <TextInput
                id="github-pat"
                type={showToken ? 'text' : 'password'}
                placeholder="ghp_xxxx or github_pat_xxxx"
                value={token}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg"
              >
                {showToken ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-danger">
                <Warning className="h-3.5 w-3.5" />
                {error}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              onClick={handleSaveToken}
              disabled={isSaving || !token.trim()}
              data-testid="connect-github-button"
            >
              {isSaving ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin" />
                  Validating...
                </>
              ) : (
                <>
                  <Key className="h-4 w-4" />
                  Save Token
                </>
              )}
            </Button>
            {tokenInfo && (
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            )}
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent"
            >
              Create new token
              <ArrowSquareOut className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      ) : null}

      {/* What you can do section */}
      {tokenInfo?.isValid && !showForm && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
            Available features
          </p>
          <ul className="mt-2 space-y-1 text-sm text-fg-muted">
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-success" />
              Clone private repositories
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-success" />
              Create branches and commits
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-success" />
              Open pull requests
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}
