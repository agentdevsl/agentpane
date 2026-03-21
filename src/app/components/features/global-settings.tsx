import { CircleNotch, Eye, EyeSlash, Gear, Key, Palette, Warning } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';
import { isValidPATFormat } from '@/lib/crypto/token-encryption';

type SettingsSection = 'api-keys' | 'appearance' | 'defaults';

interface GlobalSettingsProps {
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Key }> = [
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'defaults', label: 'Defaults', icon: Gear },
];

export function GlobalSettings({ onThemeChange }: GlobalSettingsProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('api-keys');

  return (
    <div className="flex gap-6">
      {/* Settings Sidebar */}
      <nav className="w-48 shrink-0">
        <div className="space-y-1">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-accent-muted text-accent'
                    : 'text-fg-muted hover:bg-surface-subtle hover:text-fg'
                }`}
              >
                <Icon className="h-4 w-4" />
                {section.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Settings Content */}
      <div className="flex-1">
        {activeSection === 'api-keys' && <ApiKeysSection />}
        {activeSection === 'appearance' && <AppearanceSection onThemeChange={onThemeChange} />}
        {activeSection === 'defaults' && <DefaultsSection />}
      </div>
    </div>
  );
}

function ApiKeysSection(): React.JSX.Element {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [githubPat, setGithubPat] = useState('');
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showGithubPat, setShowGithubPat] = useState(false);
  const [savedAnthropicKey, setSavedAnthropicKey] = useState<string | null>(null);
  const [savedGithubPat, setSavedGithubPat] = useState<string | null>(null);
  const [isSavingAnthropic, setIsSavingAnthropic] = useState(false);
  const [isSavingGithub, setIsSavingGithub] = useState(false);

  // Error states for user feedback
  const [loadError, setLoadError] = useState<string | null>(null);
  const [anthropicError, setAnthropicError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  // Load saved keys on mount
  useMountEffect(() => {
    const loadAnthropicKey = async () => {
      const result = await apiClient.apiKeys.get('anthropic');
      if (result.ok && result.data.keyInfo) {
        setSavedAnthropicKey(result.data.keyInfo.maskedKey);
      } else if (!result.ok) {
        console.error('Failed to load Anthropic key:', result.error);
        setLoadError('Failed to load saved API keys. Please refresh the page.');
      }
    };
    loadAnthropicKey();

    const loadGitHubToken = async () => {
      const result = await apiClient.github.getTokenInfo();
      if (result.ok && result.data.tokenInfo) {
        setSavedGithubPat(result.data.tokenInfo.maskedToken);
      } else if (!result.ok) {
        console.error('Failed to load GitHub token:', result.error);
        setLoadError('Failed to load saved API keys. Please refresh the page.');
      }
    };
    loadGitHubToken();
  });

  const handleSaveAnthropicKey = async () => {
    if (!anthropicKey.trim()) return;
    setIsSavingAnthropic(true);
    setAnthropicError(null);
    try {
      const result = await apiClient.apiKeys.save('anthropic', anthropicKey);
      if (result.ok) {
        setSavedAnthropicKey(result.data.keyInfo.maskedKey);
        setAnthropicKey('');
      } else {
        setAnthropicError(result.error.message || 'Failed to save API key');
        console.error('Failed to save Anthropic API key:', result.error);
      }
    } catch (error) {
      setAnthropicError('Network error. Please check your connection.');
      console.error('Failed to save Anthropic API key:', error);
    } finally {
      setIsSavingAnthropic(false);
    }
  };

  const handleSaveGithubPat = async () => {
    if (!githubPat.trim()) return;
    if (!isValidPATFormat(githubPat)) {
      setGithubError('Invalid format. Must start with ghp_ or github_pat_');
      return;
    }
    setIsSavingGithub(true);
    setGithubError(null);
    try {
      const result = await apiClient.github.saveToken(githubPat);
      if (result.ok) {
        setSavedGithubPat(result.data.tokenInfo.maskedToken);
        setGithubPat('');
      } else {
        setGithubError(result.error.message || 'Failed to save token');
        console.error('Failed to save GitHub PAT:', result.error);
      }
    } catch (error) {
      setGithubError('Network error. Please check your connection.');
      console.error('Failed to save GitHub PAT:', error);
    } finally {
      setIsSavingGithub(false);
    }
  };

  const handleClearAnthropicKey = async () => {
    setAnthropicError(null);
    try {
      const result = await apiClient.apiKeys.delete('anthropic');
      if (result.ok) {
        setSavedAnthropicKey(null);
      } else {
        setAnthropicError('Failed to delete API key. Please try again.');
        console.error('Failed to delete Anthropic API key:', result.error);
      }
    } catch (error) {
      setAnthropicError('Network error. Please try again.');
      console.error('Failed to delete Anthropic API key:', error);
    }
  };

  const handleClearGithubPat = async () => {
    setGithubError(null);
    try {
      const result = await apiClient.github.deleteToken();
      if (result.ok) {
        setSavedGithubPat(null);
      } else {
        setGithubError('Failed to delete token. Please try again.');
        console.error('Failed to delete GitHub PAT:', result.error);
      }
    } catch (error) {
      setGithubError('Network error. Please try again.');
      console.error('Failed to delete GitHub PAT:', error);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">API Keys</h2>
        <p className="text-sm text-fg-muted">
          Configure API keys for external services. Keys are encrypted and stored locally.
        </p>
      </div>

      {/* Load error banner */}
      {loadError && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <Warning className="h-4 w-4 flex-shrink-0" />
          {loadError}
        </div>
      )}

      {/* Anthropic API Key */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="font-medium text-fg">Anthropic API Key</h3>
        <p className="mt-1 text-sm text-fg-muted">
          Required for running Claude agents. Get your key from{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            console.anthropic.com
          </a>
        </p>
        {savedAnthropicKey ? (
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded bg-surface-subtle px-3 py-2 font-mono text-sm text-fg-muted">
              {savedAnthropicKey}
            </code>
            <Button variant="outline" size="sm" onClick={handleClearAnthropicKey}>
              Clear
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <input
                type={showAnthropicKey ? 'text' : 'password'}
                value={anthropicKey}
                onChange={(e) => {
                  setAnthropicKey(e.target.value);
                  setAnthropicError(null);
                }}
                placeholder="sk-ant-..."
                className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 pr-10 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
              >
                {showAnthropicKey ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              onClick={handleSaveAnthropicKey}
              disabled={isSavingAnthropic || !anthropicKey.trim()}
            >
              {isSavingAnthropic ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </div>
        )}
        {anthropicError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <Warning className="h-3.5 w-3.5" />
            {anthropicError}
          </p>
        )}
      </div>

      {/* GitHub PAT */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="font-medium text-fg">GitHub Personal Access Token</h3>
        <p className="mt-1 text-sm text-fg-muted">
          Optional. Used for GitHub integration features like issue sync and PR creation.
        </p>
        {savedGithubPat ? (
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded bg-surface-subtle px-3 py-2 font-mono text-sm text-fg-muted">
              {savedGithubPat}
            </code>
            <Button variant="outline" size="sm" onClick={handleClearGithubPat}>
              Clear
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <input
                type={showGithubPat ? 'text' : 'password'}
                value={githubPat}
                onChange={(e) => {
                  setGithubPat(e.target.value);
                  setGithubError(null);
                }}
                placeholder="ghp_... or github_pat_..."
                className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 pr-10 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowGithubPat(!showGithubPat)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
              >
                {showGithubPat ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={handleSaveGithubPat} disabled={isSavingGithub || !githubPat.trim()}>
              {isSavingGithub ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </div>
        )}
        {githubError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <Warning className="h-3.5 w-3.5" />
            {githubError}
          </p>
        )}
      </div>
    </div>
  );
}

function AppearanceSection({
  onThemeChange,
}: {
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
}): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    const stored = localStorage.getItem('theme');
    return (stored as 'light' | 'dark' | 'system') || 'system';
  });

  const handleThemeChange = (newTheme: 'light' | 'dark' | 'system') => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    onThemeChange?.(newTheme);

    // Apply theme to document
    if (newTheme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">Appearance</h2>
        <p className="text-sm text-fg-muted">Customize the look and feel of AgentPane.</p>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="font-medium text-fg">Theme</h3>
        <p className="mt-1 text-sm text-fg-muted">Select your preferred color scheme.</p>
        <div className="mt-4 flex gap-2">
          {(['light', 'dark', 'system'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => handleThemeChange(option)}
              className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors ${
                theme === option
                  ? 'bg-accent text-white'
                  : 'bg-surface-subtle text-fg-muted hover:bg-surface-emphasis hover:text-fg'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Setting keys used for defaults
const DEFAULTS_SETTING_KEYS = {
  MAX_TURNS: 'default_max_turns',
  MAX_CONCURRENT_AGENTS: 'default_max_concurrent_agents',
} as const;

function DefaultsSection(): React.JSX.Element {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [maxTurns, setMaxTurns] = useState('50');
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState('3');

  // Load settings from API on mount
  useMountEffect(() => {
    async function loadSettings() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await apiClient.settings.get(Object.values(DEFAULTS_SETTING_KEYS));
        if (result.ok) {
          const settings = result.data.settings;
          if (settings[DEFAULTS_SETTING_KEYS.MAX_TURNS] !== undefined) {
            setMaxTurns(String(settings[DEFAULTS_SETTING_KEYS.MAX_TURNS]));
          }
          if (settings[DEFAULTS_SETTING_KEYS.MAX_CONCURRENT_AGENTS] !== undefined) {
            setMaxConcurrentAgents(String(settings[DEFAULTS_SETTING_KEYS.MAX_CONCURRENT_AGENTS]));
          }
        } else {
          console.error('Failed to load settings:', result.error);
          setError('Failed to load settings.');
        }
      } catch (err) {
        console.error('Error loading settings:', err);
        setError('Failed to load settings.');
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  });

  const handleSaveDefaults = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const result = await apiClient.settings.update({
        [DEFAULTS_SETTING_KEYS.MAX_TURNS]: maxTurns,
        [DEFAULTS_SETTING_KEYS.MAX_CONCURRENT_AGENTS]: maxConcurrentAgents,
      });
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        console.error('Failed to save settings:', result.error);
        setError('Failed to save settings.');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
      setError('Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">Defaults</h2>
        <p className="text-sm text-fg-muted">
          Configure default settings for new projects and agents.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <Warning className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="font-medium text-fg">Agent Defaults</h3>
        <p className="mt-1 text-sm text-fg-muted">
          Default configuration applied to new agent executions.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="max-turns" className="block text-sm font-medium text-fg">
              Maximum Turns
            </label>
            <input
              id="max-turns"
              type="number"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              min={1}
              max={200}
              disabled={isLoading}
              className="mt-1 w-32 rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Maximum API turns per agent execution (1-200)
            </p>
          </div>

          <div>
            <label htmlFor="max-agents" className="block text-sm font-medium text-fg">
              Max Concurrent Agents
            </label>
            <input
              id="max-agents"
              type="number"
              value={maxConcurrentAgents}
              onChange={(e) => setMaxConcurrentAgents(e.target.value)}
              min={1}
              max={10}
              disabled={isLoading}
              className="mt-1 w-32 rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Maximum agents that can run simultaneously per project (1-10)
            </p>
          </div>
        </div>

        <div className="mt-6">
          <Button onClick={handleSaveDefaults} disabled={isLoading || isSaving}>
            {isSaving ? (
              <>
                <CircleNotch className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : saved ? (
              'Saved!'
            ) : (
              'Save Defaults'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
