import { Check, CircleNotch, Warning, WifiHigh, WifiSlash } from '@phosphor-icons/react';
import { z } from 'zod';
import { Button } from '@/app/components/ui/button';
import { Switch } from '@/app/components/ui/switch';
import type { SandboxProvider } from '@/lib/sandbox/types';
import { cn } from '@/lib/utils/cn';

// Sandbox container mode: shared or per-project
export type SandboxContainerMode = 'shared' | 'per-project';

// Default project sandbox settings that projects inherit
export interface DefaultSandboxSettings {
  enabled: boolean;
  provider: SandboxProvider;
  memoryMb: number;
  cpuCores: number;
  idleTimeoutMinutes: number;
  image?: string;
  namespace?: string;
  containerMode?: SandboxContainerMode;
  fallbackToDocker?: boolean;
}

export interface K8sStatus {
  healthy: boolean;
  message?: string;
  context?: string;
  cluster?: string;
  server?: string;
  serverVersion?: string;
  namespace?: string;
  namespaceExists?: boolean;
  pods?: number;
  podsRunning?: number;
}

export interface K8sContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
}

export interface ControllerStatus {
  installed: boolean;
  crdReady?: boolean;
  version?: string;
  crdRegistered?: boolean;
  crdApiVersion?: string;
  clusterVersion?: string | null;
  ready?: boolean;
}

export interface NomadStatus {
  healthy: boolean;
  leader: string | null;
  version: string | null;
  datacenter: string | null;
  jobCount: number;
}

export interface NomadNamespace {
  Name: string;
  Description: string;
}

export const K8sSettingsSchema = z.object({
  namespace: z.string().optional(),
  kubeConfigPath: z.string().optional(),
  kubeContext: z.string().optional(),
  enableWarmPool: z.boolean().optional(),
  warmPoolSize: z.number().optional(),
  runtimeClassName: z.enum(['gvisor', 'kata', 'none']).optional(),
  skipTLSVerify: z.boolean().optional(),
  autoStartMinikube: z.boolean().optional(),
  autoInstallCRDs: z.boolean().optional(),
});

export const NomadSettingsSchema = z.object({
  address: z.string().optional(),
  token: z.string().optional(),
  namespace: z.string().default('default'),
  region: z.string().optional(),
  datacenter: z.string().optional(),
  skipTLSVerify: z.boolean().default(false),
  image: z.string().optional(),
});

export const PROVIDER_LABELS: Record<string, string> = {
  docker: 'Docker',
  devcontainer: 'DevContainer',
  kubernetes: 'Kubernetes',
  nomad: 'Nomad',
};

export const CONFIG_TYPE_BADGES: Record<string, string> = {
  kubernetes: '☸️ K8s',
  nomad: '⬡ Nomad',
  devcontainer: '📦 DevContainer',
  docker: '🐳 Docker',
};

export type EditorMode = 'create' | 'edit' | null;

/** Resolve Nomad connection status text from loading/status state. */
export function getNomadStatusText(loading: boolean, status: { healthy: boolean } | null): string {
  if (loading) return 'Checking...';
  if (status === null) return 'Unknown';
  return status.healthy ? 'Connected' : 'Disconnected';
}

/** Resolve Nomad status text color class from loading/status state. */
export function getNomadStatusColor(loading: boolean, status: { healthy: boolean } | null): string {
  if (loading || status === null) return 'text-fg-muted';
  return status.healthy ? 'text-success' : 'text-danger';
}

export function ConnectionStatusIndicator({
  loading,
  healthy,
  statusUnknown,
  title,
  subtitle,
  errorMessage,
  onRefresh,
  refreshLabel = 'Refresh',
  refreshTestId,
}: {
  loading: boolean;
  healthy: boolean;
  statusUnknown?: boolean;
  title: string;
  subtitle?: React.ReactNode;
  errorMessage?: string | null;
  onRefresh: () => void;
  refreshLabel?: string;
  refreshTestId: string;
}) {
  let statusIcon: React.ReactNode;
  if (loading) {
    statusIcon = <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />;
  } else if (healthy) {
    statusIcon = (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success-muted">
        <WifiHigh className="h-4 w-4 text-success" />
      </div>
    );
  } else if (statusUnknown) {
    statusIcon = (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface">
        <WifiSlash className="h-4 w-4 text-fg-muted" />
      </div>
    );
  } else {
    statusIcon = (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-danger-muted">
        <WifiSlash className="h-4 w-4 text-danger" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
      <div className="flex items-center gap-3">
        {statusIcon}
        <div>
          <p className="font-medium text-fg">{title}</p>
          {subtitle}
          {!healthy && errorMessage && <p className="text-xs text-danger">{errorMessage}</p>}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={loading}
        data-testid={refreshTestId}
      >
        {loading ? <CircleNotch className="h-4 w-4 animate-spin" /> : refreshLabel}
      </Button>
    </div>
  );
}

export function ProviderCardButton({
  selected,
  onClick,
  icon,
  label,
  description,
  tags,
  accentColor = 'accent',
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
  tags: Array<{ text: string; variant?: 'accent' | 'muted' }>;
  accentColor?: 'accent' | 'attention';
  testId: string;
}) {
  // Tailwind requires static class names for JIT compilation
  const ACCENT_CLASSES = {
    accent: {
      border: 'border-accent bg-accent-muted/30',
      pill: 'bg-accent',
      tag: 'bg-accent/15 text-accent',
    },
    attention: {
      border: 'border-attention bg-attention/10',
      pill: 'bg-attention',
      tag: 'bg-attention/15 text-attention',
    },
  } as const;

  const accent = ACCENT_CLASSES[accentColor];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative cursor-pointer rounded-lg border-2 p-5 text-left transition-all',
        selected ? accent.border : 'border-border hover:border-fg-subtle'
      )}
      data-testid={testId}
    >
      {selected && (
        <div
          className={cn(
            'absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full',
            accent.pill
          )}
        >
          <Check className="h-3 w-3 text-white" weight="bold" />
        </div>
      )}
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-2xl">
        {icon}
      </div>
      <h3 className="font-semibold text-fg">{label}</h3>
      <p className="mt-1 text-sm text-fg-muted">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag.text}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs',
              tag.variant === 'accent' ? accent.tag : 'bg-surface-muted text-fg-muted'
            )}
          >
            {tag.text}
          </span>
        ))}
      </div>
    </button>
  );
}

export function InitErrorBanner({
  title,
  error,
  timestamp,
  testId,
}: {
  title: string;
  error: string;
  timestamp: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/10 p-4" data-testid={testId}>
      <div className="flex items-start gap-3">
        <Warning className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" weight="fill" />
        <div>
          <p className="text-sm font-medium text-danger">{title}</p>
          <p className="mt-1 text-sm text-fg-muted">{error}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            Last attempt: {new Date(timestamp).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onToggle,
  testId,
  ariaLabel,
}: {
  checked: boolean;
  onToggle: () => void;
  testId?: string;
  ariaLabel: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onToggle}
      data-testid={testId}
      aria-label={ariaLabel}
    />
  );
}

export function SaveButton({
  saving,
  saved,
  onClick,
  testId,
}: {
  saving: boolean;
  saved: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={saving}
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-fg-on-accent hover:bg-accent/90 disabled:opacity-50 transition-colors"
    >
      {saving ? (
        <>
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Saving...
        </>
      ) : saved ? (
        <>
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Saved
        </>
      ) : (
        'Save Settings'
      )}
    </button>
  );
}
