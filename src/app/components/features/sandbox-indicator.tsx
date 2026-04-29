import { ArrowClockwise, Cube, CubeTransparent, Hexagon, Spinner } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/app/components/ui/tooltip';
import { cn } from '@/lib/utils/cn';

export type ContainerStatus =
  | 'stopped'
  | 'creating'
  | 'running'
  | 'idle'
  | 'stopping'
  | 'error'
  | 'unavailable';

export type SandboxProviderType = 'docker' | 'devcontainer' | 'kubernetes' | 'nomad' | 'none';

const statusDotVariants = cva('h-2 w-2 rounded-full', {
  variants: {
    status: {
      creating: 'bg-secondary animate-pulse',
      running: 'bg-success',
      idle: 'bg-attention',
      stopped: 'bg-fg-muted',
      stopping: 'bg-fg-muted animate-pulse',
      error: 'bg-danger',
      unavailable: 'bg-fg-muted opacity-50',
    },
  },
  defaultVariants: {
    status: 'stopped',
  },
});

function getStatusLabel(status: ContainerStatus): string {
  switch (status) {
    case 'creating':
      return 'Starting';
    case 'running':
      return 'Online';
    case 'idle':
      return 'Idle';
    case 'stopped':
      return 'Offline';
    case 'stopping':
      return 'Stopping';
    case 'error':
      return 'Error';
    case 'unavailable':
      return 'N/A';
    default:
      return status;
  }
}

function getStatusDescription(status: ContainerStatus, provider: SandboxProviderType): string {
  const target = provider === 'kubernetes' ? 'Pod' : provider === 'nomad' ? 'Job' : 'Container';
  switch (status) {
    case 'creating':
      return `${target} is starting up...`;
    case 'running':
      return `${target} is online and ready for agent tasks`;
    case 'idle':
      return `${target} is online but idle (will auto-stop after timeout)`;
    case 'stopping':
      return `${target} is shutting down...`;
    case 'stopped':
      return `${target} is offline. It will start automatically when an agent runs.`;
    case 'error':
      return `${target} encountered an error`;
    case 'unavailable':
      return `${target} status unavailable`;
    default:
      return '';
  }
}

function getModeDescription(mode: 'shared' | 'per-project'): string {
  if (mode === 'shared') {
    return 'All projects share a single sandbox container';
  }
  return 'Each project has its own isolated sandbox container';
}

function getProviderLabel(provider: SandboxProviderType): string {
  switch (provider) {
    case 'kubernetes':
      return 'K8s';
    case 'nomad':
      return 'Nomad';
    case 'docker':
      return 'Docker';
    case 'devcontainer':
      return 'DevContainer';
    default:
      return 'Docker';
  }
}

function getProviderDescription(provider: SandboxProviderType): string {
  switch (provider) {
    case 'kubernetes':
      return 'Agents run in isolated Kubernetes pods for security.';
    case 'nomad':
      return 'Agents run in Nomad-scheduled Docker containers for security.';
    case 'docker':
      return 'Agents run in isolated Docker containers for security.';
    case 'devcontainer':
      return 'Agents run in VS Code-compatible DevContainers for reproducible environments.';
    default:
      return 'Agents run in isolated containers for security.';
  }
}

function getUnavailableDescription(provider: SandboxProviderType): {
  title: string;
  description: string;
} {
  if (provider === 'kubernetes') {
    return {
      title: 'Kubernetes Not Available',
      description:
        'The sandbox requires a Kubernetes cluster to run agent tasks in isolated pods. Please check your cluster connection in Settings.',
    };
  }
  if (provider === 'nomad') {
    return {
      title: 'Nomad Not Available',
      description:
        'The sandbox requires a Nomad cluster to schedule agent tasks as jobs. Please check your Nomad cluster connection in Settings.',
    };
  }
  if (provider === 'devcontainer') {
    return {
      title: 'DevContainer Not Available',
      description:
        'The sandbox requires Docker and a devcontainer.json configuration to run agent tasks in DevContainers. Please check your Docker installation and project configuration.',
    };
  }
  return {
    title: 'Docker Not Available',
    description:
      'The sandbox requires Docker to run agent tasks in isolated containers. Please install and start Docker to enable sandbox features.',
  };
}

export interface SandboxIndicatorProps {
  mode: 'shared' | 'per-project';
  containerStatus: ContainerStatus;
  providerAvailable: boolean;
  provider?: SandboxProviderType;
  isLoading?: boolean;
  isRestarting?: boolean;
  onRestart?: () => void;
  className?: string;
  k8sCrdReady?: boolean;
  k8sClusterVersion?: string | null;
  k8sPodCount?: number;
  k8sPodsRunning?: number;
  nomadHealthy?: boolean;
  nomadVersion?: string | null;
  nomadLeader?: string | null;
  nomadJobCount?: number;
}

/**
 * Sandbox status indicator for the title bar
 * Shows sandbox mode (shared/project) and container status with helpful tooltips
 */
export function SandboxIndicator({
  mode,
  containerStatus,
  providerAvailable,
  provider = 'docker',
  isLoading = false,
  isRestarting = false,
  onRestart,
  className,
  k8sCrdReady,
  k8sClusterVersion,
  k8sPodCount,
  k8sPodsRunning,
  nomadHealthy,
  nomadVersion,
  nomadLeader,
  nomadJobCount,
}: SandboxIndicatorProps): React.JSX.Element {
  const isTransitioning =
    containerStatus === 'creating' || containerStatus === 'stopping' || isRestarting;
  const modeLabel = mode === 'shared' ? 'Shared' : 'Per-Project';
  const providerLabel = getProviderLabel(provider);

  if (provider === 'kubernetes' && k8sCrdReady === false && providerAvailable) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex cursor-help items-center gap-1.5 rounded-md border border-attention bg-surface-subtle px-2.5 py-1.5 text-xs text-attention',
                className
              )}
            >
              <CubeTransparent className="h-4 w-4" />
              <span className="font-medium">K8s</span>
              <span>CRDs Missing</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px]">
            <p className="font-medium">Kubernetes CRDs Missing</p>
            <p className="mt-1 text-fg-muted">
              The Agent Sandbox CRDs are not installed on the cluster. Install them in Settings to
              enable Kubernetes sandboxes.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!providerAvailable) {
    const unavailable = getUnavailableDescription(provider);
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex cursor-help items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2.5 py-1.5 text-xs text-fg-muted',
                className
              )}
            >
              <CubeTransparent className="h-4 w-4 opacity-50" />
              <span className="font-medium opacity-50">Sandbox</span>
              <span className="opacity-50">Unavailable</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px]">
            <p className="font-medium">{unavailable.title}</p>
            <p className="mt-1 text-fg-muted">{unavailable.description}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex cursor-help items-center gap-2 rounded-md border border-border bg-surface-subtle px-2.5 py-1.5',
              className
            )}
          >
            {/* Sandbox label with icon */}
            <div className="flex items-center gap-1.5 text-xs">
              {provider === 'nomad' ? (
                <Hexagon className="h-4 w-4 text-fg-muted" />
              ) : (
                <Cube className="h-4 w-4 text-fg-muted" />
              )}
              <span className="font-medium text-fg-muted">{providerLabel}</span>
            </div>

            {/* Divider */}
            <div className="h-4 w-px bg-border" />

            {/* Mode badge */}
            <span className="rounded bg-surface px-1.5 py-0.5 text-xs text-fg-muted">
              {modeLabel}
            </span>

            {/* Container status */}
            <div className="flex items-center gap-1.5">
              {isLoading || isTransitioning ? (
                <Spinner className="h-3.5 w-3.5 animate-spin text-secondary" />
              ) : (
                <div className={statusDotVariants({ status: containerStatus })} />
              )}
              <span
                className={cn(
                  'text-xs font-medium',
                  containerStatus === 'running' && 'text-success',
                  containerStatus === 'creating' && 'text-secondary',
                  containerStatus === 'error' && 'text-danger',
                  containerStatus === 'idle' && 'text-attention',
                  containerStatus === 'stopping' && 'text-fg-muted',
                  (containerStatus === 'stopped' || containerStatus === 'unavailable') &&
                    'text-fg-muted'
                )}
              >
                {getStatusLabel(containerStatus)}
              </span>
            </div>

            {/* Restart button */}
            {onRestart && providerAvailable && (
              <>
                <div className="h-4 w-px bg-border" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestart();
                  }}
                  disabled={isRestarting}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    'text-fg-muted hover:bg-surface hover:text-fg',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                  title={`Restart ${provider === 'kubernetes' ? 'pod' : provider === 'nomad' ? 'job' : 'container'}`}
                >
                  <ArrowClockwise
                    className={cn('h-3.5 w-3.5', isRestarting && 'animate-spin')}
                    weight="bold"
                  />
                </button>
              </>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[300px]">
          <div className="space-y-2">
            <div>
              <p className="font-medium">Sandbox Environment</p>
              <p className="mt-0.5 text-fg-muted">{getProviderDescription(provider)}</p>
            </div>
            <div className="border-t border-border pt-2">
              <p className="text-fg-muted">
                <span className="font-medium text-fg">Mode:</span> {modeLabel}
              </p>
              <p className="text-fg-muted">{getModeDescription(mode)}</p>
            </div>
            <div className="border-t border-border pt-2">
              <p className="text-fg-muted">
                <span className="font-medium text-fg">Status:</span>{' '}
                {getStatusLabel(containerStatus)}
              </p>
              <p className="text-fg-muted">{getStatusDescription(containerStatus, provider)}</p>
            </div>
            {provider === 'kubernetes' && (
              <div className="border-t border-border pt-2">
                <p className="font-medium text-fg">Cluster Health</p>
                <div className="mt-1 space-y-1">
                  <p className="flex items-center gap-1.5 text-fg-muted">
                    <span
                      className={cn(
                        'inline-block h-1.5 w-1.5 rounded-full',
                        k8sCrdReady ? 'bg-success' : 'bg-danger'
                      )}
                    />
                    {k8sCrdReady ? 'CRDs Ready' : 'CRDs Missing'}
                  </p>
                  {k8sClusterVersion && (
                    <p className="text-fg-muted">Cluster: {k8sClusterVersion}</p>
                  )}
                  {k8sPodCount !== undefined && (
                    <p className="text-fg-muted">
                      {k8sPodsRunning ?? 0}/{k8sPodCount} pods running
                    </p>
                  )}
                </div>
              </div>
            )}
            {provider === 'nomad' && (
              <div className="border-t border-border pt-2">
                <p className="font-medium text-fg">Nomad Cluster</p>
                <div className="mt-1 space-y-1">
                  <p className="flex items-center gap-1.5 text-fg-muted">
                    <span
                      className={cn(
                        'inline-block h-1.5 w-1.5 rounded-full',
                        nomadHealthy ? 'bg-success' : 'bg-danger'
                      )}
                    />
                    {nomadHealthy ? nomadLeader || 'Leader Elected' : 'No Leader'}
                  </p>
                  {nomadVersion && <p className="text-fg-muted">Version: {nomadVersion}</p>}
                  {nomadJobCount !== undefined && (
                    <p className="text-fg-muted">{nomadJobCount} sandbox jobs</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
