import {
  Brain,
  ChatText,
  Cube,
  Folder,
  Gear,
  GithubLogo,
  Heartbeat,
  Hexagon,
  Key,
  Lightning,
  Robot,
  Swatches,
  Terminal,
} from '@phosphor-icons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { apiClient } from '@/lib/api/client';

type SettingsNavItem = {
  id: string;
  label: string;
  to: string;
  icon: typeof GithubLogo;
  badge?: string;
  badgeVariant?: 'success' | 'warning' | 'info';
};

type SettingsSection = {
  id: string;
  title: string;
  items: SettingsNavItem[];
};

function useSettingsSections(): SettingsSection[] {
  const [githubConnected, setGithubConnected] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);

  useMountEffect(() => {
    // Check GitHub connection status via API
    const checkGitHub = async () => {
      const result = await apiClient.github.getTokenInfo();
      setGithubConnected(result.ok && result.data.tokenInfo?.isValid === true);
    };
    checkGitHub();

    // Check if Anthropic API key is configured via API
    const checkAnthropicKey = async () => {
      const result = await apiClient.apiKeys.get('anthropic');
      setHasApiKey(result.ok && result.data.keyInfo !== null);
    };
    checkAnthropicKey();
  });

  return [
    {
      id: 'global',
      title: 'Global Settings',
      items: [
        {
          id: 'api-keys',
          label: 'API Keys',
          to: '/settings/api-keys',
          icon: Key,
          badge: hasApiKey ? 'Set' : undefined,
          badgeVariant: hasApiKey ? 'success' : undefined,
        },
        { id: 'appearance', label: 'Appearance', to: '/settings/appearance', icon: Swatches },
        { id: 'sandbox', label: 'Sandbox', to: '/settings/sandbox', icon: Cube },
      ],
    },
    {
      id: 'agent-config',
      title: 'Agent Configuration',
      items: [
        { id: 'preferences', label: 'Agent Defaults', to: '/settings/preferences', icon: Gear },
        {
          id: 'model-optimizations',
          label: 'Model Optimizations',
          to: '/settings/model-optimizations',
          icon: Brain,
        },
        {
          id: 'prompts',
          label: 'System Prompts',
          to: '/settings/prompts',
          icon: ChatText,
        },
      ],
    },
    {
      id: 'health',
      title: 'Health',
      items: [
        { id: 'system', label: 'System Health', to: '/settings/system', icon: Heartbeat },
        { id: 'cli-monitor', label: 'CLI Monitor', to: '/settings/cli-monitor', icon: Terminal },
        {
          id: 'github',
          label: 'GitHub',
          to: '/settings/github',
          icon: GithubLogo,
          badge: githubConnected ? 'Connected' : undefined,
          badgeVariant: githubConnected ? 'success' : undefined,
        },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      items: [
        { id: 'events', label: 'Events', to: '/events/sources', icon: Lightning },
        { id: 'terraform', label: 'Terraform', to: '/terraform/settings', icon: Hexagon },
      ],
    },
    {
      id: 'navigation',
      title: 'Navigation',
      items: [
        { id: 'codespaces', label: 'Codespaces', to: '/settings/projects', icon: Folder },
        { id: 'agents', label: 'Agents', to: '/settings/agents', icon: Robot },
      ],
    },
  ];
}

export function SettingsSidebar(): React.JSX.Element {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const sections = useSettingsSections();

  return (
    <aside
      data-testid="settings-sidebar"
      className="flex h-screen w-64 flex-col border-r border-border bg-surface"
    >
      {/* Header with logo */}
      <Link
        to="/"
        className="flex items-center gap-2.5 border-b border-border px-4 py-5 transition-colors hover:bg-surface-subtle"
      >
        <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-surface-subtle shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_-1px_0_0_rgba(0,0,0,0.3)_inset,0_4px_16px_-2px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
          <div className="absolute inset-0 animate-pulse rounded-xl bg-gradient-radial from-done/10 to-transparent dark:from-done/15" />
          <svg
            className="relative z-10 h-7 w-7 drop-shadow-[0_0_8px_rgba(163,113,247,0.4)]"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <radialGradient id="coreGradSettings" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#fff" />
                <stop offset="50%" stopColor="#3fb950" />
                <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* Connection lines */}
            <line
              x1="14"
              y1="14"
              x2="6"
              y2="8"
              stroke="#58a6ff"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <line
              x1="14"
              y1="14"
              x2="22"
              y2="6"
              stroke="#a371f7"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <line
              x1="14"
              y1="14"
              x2="26"
              y2="16"
              stroke="#3fb950"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <line
              x1="14"
              y1="14"
              x2="20"
              y2="26"
              stroke="#f778ba"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <line
              x1="14"
              y1="14"
              x2="6"
              y2="22"
              stroke="#d29922"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            {/* Outer nodes */}
            <circle className="animate-pulse" cx="6" cy="8" r="2" fill="#58a6ff" />
            <circle className="animate-pulse" cx="22" cy="6" r="2.5" fill="#a371f7" />
            <circle className="animate-pulse" cx="26" cy="16" r="2" fill="#3fb950" />
            <circle className="animate-pulse" cx="20" cy="26" r="3" fill="#f778ba" />
            <circle className="animate-pulse" cx="6" cy="22" r="2" fill="#d29922" />
            {/* Center hub */}
            <circle cx="14" cy="14" r="5" fill="url(#coreGradSettings)" />
            <circle cx="14" cy="14" r="2" fill="#fff" />
          </svg>
        </div>
        <span className="text-base font-semibold text-fg">AgentPane</span>
      </Link>

      {/* Navigation sections */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sections.map((section) => (
          <div key={section.id} className="py-2">
            <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {section.title}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = currentPath === item.to || currentPath.startsWith(`${item.to}/`);

                return (
                  <li key={item.id}>
                    <Link
                      to={item.to}
                      data-testid={`settings-nav-${item.id}`}
                      data-active={isActive}
                      className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                        isActive
                          ? 'border-l-2 border-accent bg-accent-muted text-fg'
                          : 'border-l-2 border-transparent text-fg-muted hover:bg-surface-subtle hover:text-fg'
                      }`}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      {item.label}
                      {item.badge && (
                        <span
                          className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${
                            item.badgeVariant === 'success'
                              ? 'bg-success-muted text-success'
                              : item.badgeVariant === 'warning'
                                ? 'bg-attention-muted text-attention'
                                : 'bg-accent-muted text-accent'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
