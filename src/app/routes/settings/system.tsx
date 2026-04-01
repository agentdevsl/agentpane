import type { Icon } from '@phosphor-icons/react';
import {
  ArrowClockwise,
  Check,
  CircleNotch,
  Clock,
  Database,
  GithubLogo,
  Globe,
  HardDrives,
  Heartbeat,
  Lightning,
  Warning,
  X,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { useInterval } from '@/app/hooks/use-interval';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

export const Route = createFileRoute('/settings/system')({
  component: SystemHealthPage,
});

type HealthStatus = {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  checks: {
    database: {
      status: 'ok' | 'error';
      latencyMs?: number;
      mode?: string;
      version?: string;
      error?: string;
    };
    github: { status: 'ok' | 'error' | 'not_configured'; login?: string | null };
  };
  responseTimeMs: number;
};

type FrontendHealth = {
  status: 'ok' | 'error';
  viteServer: boolean;
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ============================================================================
// StatusCard Component (internal card pattern from model-optimizations)
// ============================================================================

function StatusCard({
  icon: IconComponent,
  title,
  subtitle,
  status,
  statusLabel,
}: {
  icon: Icon;
  title: string;
  subtitle?: string;
  status: 'ok' | 'error' | 'not_configured';
  statusLabel: string;
}) {
  const statusStyles = {
    ok: { bg: 'bg-success-muted', text: 'text-success', icon: Check },
    error: { bg: 'bg-danger-muted', text: 'text-danger', icon: X },
    not_configured: { bg: 'bg-attention-muted', text: 'text-attention', icon: Warning },
  };

  const style = statusStyles[status];
  const StatusIcon = style.icon;

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/70 bg-surface-subtle/30 p-4 transition-all hover:border-border">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
          <IconComponent className="h-4 w-4 text-fg-muted" weight="duotone" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {subtitle ? <p className="text-xs text-fg-muted">{subtitle}</p> : null}
        </div>
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
          style.bg,
          style.text
        )}
      >
        <StatusIcon className="h-3.5 w-3.5" weight="bold" />
        {statusLabel}
      </span>
    </div>
  );
}

// ============================================================================
// MetricCard Component (internal card pattern from model-optimizations)
// ============================================================================

function MetricCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number;
  unit?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-4 transition-all hover:border-border">
      <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-fg">
        {value}
        {unit ? <span className="ml-0.5 text-sm font-normal text-fg-muted">{unit}</span> : null}
      </p>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

function SystemHealthPage(): React.JSX.Element {
  const [backendHealth, setBackendHealth] = useState<HealthStatus | null>(null);
  const [frontendHealth, setFrontendHealth] = useState<FrontendHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const checkHealth = useCallback(async () => {
    setIsLoading(true);

    const [viteResult, apiResult] = await Promise.allSettled([
      fetch('/'),
      apiClient.system.health(),
    ]);

    if (viteResult.status === 'fulfilled') {
      setFrontendHealth({
        status: viteResult.value.ok ? 'ok' : 'error',
        viteServer: viteResult.value.ok,
      });
    } else {
      setFrontendHealth({ status: 'error', viteServer: false });
    }

    if (apiResult.status === 'fulfilled' && apiResult.value.ok) {
      setBackendHealth(apiResult.value.data);
    } else {
      setBackendHealth(null);
    }

    setLastChecked(new Date());
    setIsLoading(false);
  }, []);

  useWatchEffect(() => {
    void checkHealth();
  }, [checkHealth]);
  useInterval(checkHealth, 30000);

  const overallStatus =
    frontendHealth?.status === 'ok' && backendHealth?.status === 'healthy' ? 'healthy' : 'degraded';

  return (
    <div data-testid="system-health-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header with gradient accent */}
      <header className="relative mb-10">
        {/* Decorative background elements */}
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20">
              <Heartbeat className="h-6 w-6 text-accent" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">System Health</h1>
              <p className="text-sm text-fg-muted">Monitor the health status of all services</p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex flex-wrap gap-6">
              <div className="flex items-center gap-2">
                {overallStatus === 'healthy' ? (
                  <Check className="h-4 w-4 text-success" weight="bold" />
                ) : (
                  <Warning className="h-4 w-4 text-attention" weight="bold" />
                )}
                <span className="text-xs text-fg-muted">
                  Status:{' '}
                  <span
                    className={cn(
                      'font-medium',
                      overallStatus === 'healthy' ? 'text-success' : 'text-attention'
                    )}
                  >
                    {overallStatus === 'healthy' ? 'All Operational' : 'Degraded'}
                  </span>
                </span>
              </div>
              {lastChecked ? (
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-fg-subtle" />
                  <span className="text-xs text-fg-muted">
                    Last checked:{' '}
                    <span className="font-medium text-fg">{lastChecked.toLocaleTimeString()}</span>
                  </span>
                </div>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={checkHealth} disabled={isLoading}>
              {isLoading ? (
                <CircleNotch className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowClockwise className="h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="space-y-5">
        {/* Frontend Section */}
        <ConfigSection
          icon={Globe}
          title="Frontend Server"
          description="Vite development server on port 3000"
          badge="UI"
          badgeColor="accent"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Port" value="3000" />
            <MetricCard label="Server" value="Vite" />
            <MetricCard label="Status" value={frontendHealth?.viteServer ? 'Running' : 'Offline'} />
          </div>
        </ConfigSection>

        {/* Backend Section */}
        <ConfigSection
          icon={HardDrives}
          title="Backend Server"
          description="Bun API server on port 3001"
          badge="API"
          badgeColor="claude"
        >
          {backendHealth ? (
            <div className="space-y-5">
              {/* Metrics */}
              <div className="grid gap-4 sm:grid-cols-4">
                <MetricCard label="Port" value="3001" />
                <MetricCard label="Uptime" value={formatUptime(backendHealth.uptime)} />
                <MetricCard label="Response" value={backendHealth.responseTimeMs} unit="ms" />
                <MetricCard label="Runtime" value="Bun" />
              </div>

              {/* Service Checks */}
              <div>
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                  Service Checks
                </p>
                <div className="space-y-2">
                  <StatusCard
                    icon={Database}
                    title={
                      backendHealth.checks.database.version ??
                      (backendHealth.checks.database.mode === 'postgres'
                        ? 'PostgreSQL'
                        : 'SQLite Database')
                    }
                    subtitle={
                      [
                        backendHealth.checks.database.mode
                          ? `Mode: ${backendHealth.checks.database.mode}`
                          : undefined,
                        backendHealth.checks.database.latencyMs !== undefined
                          ? `${backendHealth.checks.database.latencyMs}ms latency`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ') || undefined
                    }
                    status={backendHealth.checks.database.status}
                    statusLabel={
                      backendHealth.checks.database.status === 'ok' ? 'Healthy' : 'Error'
                    }
                  />
                  <StatusCard
                    icon={GithubLogo}
                    title="GitHub Integration"
                    subtitle={
                      backendHealth.checks.github.login
                        ? `@${backendHealth.checks.github.login}`
                        : undefined
                    }
                    status={backendHealth.checks.github.status}
                    statusLabel={
                      backendHealth.checks.github.status === 'ok'
                        ? 'Connected'
                        : backendHealth.checks.github.status === 'not_configured'
                          ? 'Not Configured'
                          : 'Error'
                    }
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-danger-muted">
                <Warning className="h-6 w-6 text-danger" weight="duotone" />
              </div>
              <p className="font-medium text-danger">Backend server is not responding</p>
              <p className="mt-1 text-sm text-fg-muted">
                Make sure the API server is running on port 3001
              </p>
              <code className="mt-3 block rounded-lg border border-border/50 bg-surface/50 px-4 py-2 font-mono text-xs text-fg-muted">
                bun run src/server/api.ts
              </code>
            </div>
          )}
        </ConfigSection>

        {/* Help Card */}
        <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 transition-all hover:border-border">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
              <Lightning className="h-4 w-4 text-fg-muted" weight="duotone" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-fg">Troubleshooting</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                If services are offline, restart them. Frontend runs on{' '}
                <code className="rounded bg-surface-emphasis px-1.5 py-0.5 text-[11px]">
                  localhost:3000
                </code>{' '}
                and backend on{' '}
                <code className="rounded bg-surface-emphasis px-1.5 py-0.5 text-[11px]">
                  localhost:3001
                </code>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
