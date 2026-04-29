import { Check, CircleNotch, CloudArrowUp, Gauge, Warning } from '@phosphor-icons/react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { cn } from '@/lib/utils/cn';
import {
  ConnectionStatusIndicator,
  type ControllerStatus,
  InitErrorBanner,
  type K8sContext,
  type K8sStatus,
  SaveButton,
  Toggle,
} from './-shared.js';

export interface K8sConfigProps {
  k8sStatus: K8sStatus | null;
  k8sStatusLoading: boolean;
  k8sContexts: K8sContext[];
  k8sContextsLoading: boolean;
  k8sConfigPath: string;
  setK8sConfigPath: (value: string) => void;
  k8sContext: string;
  setK8sContext: (value: string) => void;
  k8sNamespace: string;
  setK8sNamespace: (value: string) => void;
  runtimeClass: 'gvisor' | 'kata' | 'none';
  setRuntimeClass: (value: 'gvisor' | 'kata' | 'none') => void;
  skipTLSVerify: boolean;
  setSkipTLSVerify: (value: boolean) => void;
  warmPoolEnabled: boolean;
  setWarmPoolEnabled: (value: boolean) => void;
  warmPoolSize: number;
  setWarmPoolSize: (value: number) => void;
  autoInstallCRDs: boolean;
  setAutoInstallCRDs: (value: boolean) => void;
  autoInstallingCRDs: boolean;
  autoStartMinikube: boolean;
  setAutoStartMinikube: (value: boolean) => void;
  fallbackToDocker: boolean;
  setFallbackToDocker: (value: boolean) => void;
  controllerStatus: ControllerStatus | null;
  controllerLoading: boolean;
  k8sInitError: { error: string; timestamp: string } | null;
  minikubeStarting: boolean;
  handleStartMinikube: () => void;
  loadK8sStatus: () => void;
  isSavingDefaults: boolean;
  defaultsSaved: boolean;
  saveDefaultSettings: () => void;
}

export function K8sConfig({
  k8sStatus,
  k8sStatusLoading,
  k8sContexts,
  k8sContextsLoading,
  k8sConfigPath,
  setK8sConfigPath,
  k8sContext,
  setK8sContext,
  k8sNamespace,
  setK8sNamespace,
  runtimeClass,
  setRuntimeClass,
  skipTLSVerify,
  setSkipTLSVerify,
  warmPoolEnabled,
  setWarmPoolEnabled,
  warmPoolSize,
  setWarmPoolSize,
  autoInstallCRDs,
  setAutoInstallCRDs,
  autoInstallingCRDs,
  autoStartMinikube,
  setAutoStartMinikube,
  fallbackToDocker,
  setFallbackToDocker,
  controllerStatus,
  controllerLoading,
  k8sInitError,
  minikubeStarting,
  handleStartMinikube,
  loadK8sStatus,
  isSavingDefaults,
  defaultsSaved,
  saveDefaultSettings,
}: K8sConfigProps): React.JSX.Element {
  return (
    <ConfigSection
      icon={CloudArrowUp}
      title="Kubernetes Configuration"
      description="Configure your Kubernetes cluster connection"
      badge={k8sStatus?.healthy ? 'Connected' : k8sStatus?.context ? 'Unreachable' : 'Disconnected'}
      badgeColor={k8sStatus?.healthy ? 'success' : 'accent'}
      testId="k8s-config-section"
    >
      <div className="space-y-6">
        <ConnectionStatusIndicator
          loading={k8sStatusLoading}
          healthy={!!k8sStatus?.healthy}
          title={
            k8sStatusLoading
              ? 'Checking connection...'
              : k8sStatus?.healthy
                ? 'Connected'
                : 'Cluster Unreachable'
          }
          subtitle={
            <>
              {k8sStatus?.healthy && k8sStatus.cluster && (
                <p className="text-xs text-fg-muted">
                  {k8sStatus.cluster} ({k8sStatus.serverVersion})
                </p>
              )}
              {!k8sStatus?.healthy && k8sStatus?.context && (
                <p className="text-xs text-fg-muted">Context: {k8sStatus.context}</p>
              )}
            </>
          }
          errorMessage={!k8sStatus?.healthy ? k8sStatus?.message : null}
          onRefresh={loadK8sStatus}
          refreshTestId="refresh-k8s-status"
        />

        {/* CRD Controller Status */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
          <div className="flex items-center gap-3">
            {controllerLoading || autoInstallingCRDs ? (
              <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />
            ) : controllerStatus?.installed ? (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success-muted">
                <Check className="h-4 w-4 text-success" weight="bold" />
              </div>
            ) : controllerStatus?.crdReady ? (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success-muted">
                <Check className="h-4 w-4 text-success" weight="bold" />
              </div>
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-danger-muted">
                <Warning className="h-4 w-4 text-danger" />
              </div>
            )}
            <div>
              <p className="font-medium text-fg">
                {controllerLoading
                  ? 'Checking controller...'
                  : autoInstallingCRDs
                    ? 'Installing CRDs...'
                    : controllerStatus?.installed
                      ? 'Agent Sandbox Controller'
                      : controllerStatus?.crdReady
                        ? 'CRDs Ready'
                        : !controllerStatus?.clusterVersion
                          ? 'Cluster Unreachable'
                          : 'CRDs Not Installed'}
              </p>
              {controllerStatus?.installed && (
                <p className="text-xs text-fg-muted">
                  v{controllerStatus.version} &middot; CRD{' '}
                  {controllerStatus.crdApiVersion ?? 'v1alpha1'}
                </p>
              )}
              {controllerStatus?.crdReady && !controllerStatus?.installed && (
                <p className="text-xs text-fg-muted">External controller not deployed (optional)</p>
              )}
              {autoInstallingCRDs && (
                <p className="text-xs text-fg-muted">Auto-installing CRDs and controller...</p>
              )}
              {!controllerStatus?.crdReady &&
                !controllerLoading &&
                !autoInstallingCRDs &&
                !controllerStatus?.clusterVersion && (
                  <p className="text-xs text-danger">
                    Cannot reach the Kubernetes cluster. Check that minikube or your cluster is
                    running.
                  </p>
                )}
              {!controllerStatus?.crdReady &&
                !controllerLoading &&
                !autoInstallingCRDs &&
                controllerStatus?.clusterVersion && (
                  <p className="text-xs text-danger">
                    Install the Agent Sandbox CRDs to use Kubernetes sandboxes
                  </p>
                )}
            </div>
          </div>
        </div>

        {/* K8s Form Fields */}
        <div className="space-y-4">
          {/* Kubeconfig Path */}
          <div>
            <label htmlFor="k8s-config-path" className="mb-1.5 block text-sm font-medium text-fg">
              Kubeconfig Path
              <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
            </label>
            <input
              id="k8s-config-path"
              type="text"
              value={k8sConfigPath}
              onChange={(e) => setK8sConfigPath(e.target.value)}
              placeholder="~/.kube/config"
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="k8s-config-path-input"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Leave empty to use default kubeconfig discovery
            </p>
          </div>

          {/* Skip TLS Verification */}
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-fg">Skip TLS Verification</p>
              <p className="text-xs text-fg-muted">
                Required for local clusters with self-signed certificates (minikube, kind)
              </p>
            </div>
            <Toggle
              checked={skipTLSVerify}
              onToggle={() => setSkipTLSVerify(!skipTLSVerify)}
              testId="k8s-skip-tls-toggle"
              ariaLabel="Skip TLS Verification"
            />
          </div>

          {/* Context Selection */}
          <div>
            <label htmlFor="k8s-context" className="mb-1.5 block text-sm font-medium text-fg">
              Context
            </label>
            <div className="relative">
              <select
                id="k8s-context"
                value={k8sContext}
                onChange={(e) => setK8sContext(e.target.value)}
                disabled={k8sContextsLoading || k8sContexts.length === 0}
                className="w-full appearance-none rounded-md border border-border bg-surface-subtle px-3 py-2 pr-10 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                data-testid="k8s-context-select"
              >
                {k8sContexts.length === 0 && <option value="">No contexts available</option>}
                {k8sContexts.map((ctx) => (
                  <option key={ctx.name} value={ctx.name}>
                    {ctx.name} ({ctx.cluster})
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                {k8sContextsLoading ? (
                  <CircleNotch className="h-4 w-4 animate-spin text-fg-muted" />
                ) : (
                  <svg
                    className="h-4 w-4 text-fg-muted"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                )}
              </div>
            </div>
          </div>

          {/* Namespace */}
          <div>
            <label htmlFor="k8s-namespace" className="mb-1.5 block text-sm font-medium text-fg">
              Namespace
            </label>
            <input
              id="k8s-namespace"
              type="text"
              value={k8sNamespace}
              onChange={(e) => setK8sNamespace(e.target.value)}
              placeholder="agentpane-sandboxes"
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="k8s-namespace-input"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Namespace for sandbox pods (will be created if it doesn&apos;t exist)
            </p>
          </div>

          {/* Runtime Class */}
          <div>
            <label htmlFor="k8s-runtime-class" className="mb-1.5 block text-sm font-medium text-fg">
              Runtime Class
            </label>
            <select
              id="k8s-runtime-class"
              value={runtimeClass}
              onChange={(e) => setRuntimeClass(e.target.value as 'gvisor' | 'kata' | 'none')}
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="k8s-runtime-class-select"
            >
              <option value="none">Default (runc)</option>
              <option value="gvisor">gVisor (runsc) -- Recommended</option>
              <option value="kata">Kata Containers (VM isolation)</option>
            </select>
            <p className="mt-1 text-xs text-fg-muted">
              gVisor provides user-space kernel isolation with low overhead. Kata uses lightweight
              VMs for stronger isolation. Default uses the cluster&apos;s standard container
              runtime.
            </p>
          </div>
        </div>

        {/* Cluster Info - shown when connected */}
        {k8sStatus?.healthy && (
          <div className="rounded-lg bg-surface-subtle p-4">
            <h4 className="mb-3 text-sm font-medium text-fg">Cluster Details</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-fg-muted">Server:</span>
                <p className="font-mono text-xs text-fg">{k8sStatus.server}</p>
              </div>
              <div>
                <span className="text-fg-muted">Version:</span>
                <p className="font-mono text-xs text-fg">{k8sStatus.serverVersion}</p>
              </div>
              <div>
                <span className="text-fg-muted">Namespace:</span>
                <p className="font-mono text-xs text-fg">
                  {k8sStatus.namespace}
                  {k8sStatus.namespaceExists ? (
                    <span className="ml-1 text-success">(exists)</span>
                  ) : (
                    <span className="ml-1 text-attention">(will be created)</span>
                  )}
                </p>
              </div>
              <div>
                <span className="text-fg-muted">Sandbox Pods:</span>
                <p className="font-mono text-xs text-fg">
                  {k8sStatus.podsRunning}/{k8sStatus.pods} running
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Warm Pool Configuration */}
        <div className="space-y-4">
          {/* Warm Pool Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                  warmPoolEnabled ? 'bg-success/20 text-success' : 'bg-surface-muted text-fg-muted'
                )}
              >
                <Gauge className="h-5 w-5" weight={warmPoolEnabled ? 'fill' : 'regular'} />
              </div>
              <div>
                <p className="font-medium text-fg">Warm Pool</p>
                <p className="text-sm text-fg-muted">
                  {warmPoolEnabled
                    ? `Maintaining ${warmPoolSize} pre-warmed sandbox${warmPoolSize !== 1 ? 'es' : ''} for instant allocation`
                    : 'Sandboxes are created on-demand (cold start ~10-30s)'}
                </p>
              </div>
            </div>
            <Toggle
              checked={warmPoolEnabled}
              onToggle={() => setWarmPoolEnabled(!warmPoolEnabled)}
              testId="k8s-warm-pool-toggle"
              ariaLabel="Warm Pool"
            />
          </div>

          {/* Warm Pool Size Slider -- only shown when enabled */}
          {warmPoolEnabled && (
            <div className="pl-4">
              <label
                htmlFor="k8s-warm-pool-size"
                className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
              >
                <span>Pool Size</span>
                <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
                  {warmPoolSize} sandbox{warmPoolSize !== 1 ? 'es' : ''}
                </span>
              </label>
              <input
                id="k8s-warm-pool-size"
                type="range"
                min={1}
                max={10}
                step={1}
                value={warmPoolSize}
                onChange={(e) => setWarmPoolSize(Number(e.target.value))}
                className="w-full accent-accent"
                data-testid="k8s-warm-pool-size-slider"
              />
              <div className="mt-1 flex justify-between text-xs text-fg-subtle">
                <span>1</span>
                <span>10</span>
              </div>
            </div>
          )}
        </div>

        {k8sInitError && (
          <InitErrorBanner
            title="Kubernetes Initialization Failed"
            error={k8sInitError.error}
            timestamp={k8sInitError.timestamp}
            testId="k8s-init-error-banner"
          />
        )}

        {/* Auto-install CRDs Toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-fg">Auto-install CRDs</p>
            <p className="text-xs text-fg-muted">
              Automatically install AgentPane CRDs and namespace when connecting to the cluster
            </p>
          </div>
          <Toggle
            checked={autoInstallCRDs}
            onToggle={() => setAutoInstallCRDs(!autoInstallCRDs)}
            testId="k8s-auto-install-crds-toggle"
            ariaLabel="Auto-install CRDs"
          />
        </div>

        {/* Auto-start Minikube Toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-fg">Auto-start Minikube</p>
            <p className="text-xs text-fg-muted">
              Automatically run &apos;minikube start&apos; if the cluster is unreachable and context
              is minikube
            </p>
          </div>
          <Toggle
            checked={autoStartMinikube}
            onToggle={() => setAutoStartMinikube(!autoStartMinikube)}
            testId="k8s-auto-start-minikube-toggle"
            ariaLabel="Auto-start Minikube"
          />
        </div>

        {/* Fall back to Docker Toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-fg">Fall back to Docker if unavailable</p>
            <p className="text-xs text-fg-muted">
              If the Kubernetes cluster is unreachable, fall back to Docker instead of disabling
              container agents
            </p>
          </div>
          <Toggle
            checked={fallbackToDocker}
            onToggle={() => setFallbackToDocker(!fallbackToDocker)}
            testId="k8s-fallback-to-docker-toggle"
            ariaLabel="Fall back to Docker if unavailable"
          />
        </div>

        {/* Start Minikube + Save buttons */}
        <div className="flex items-center justify-between">
          {/* Start Minikube button - only when unreachable and context is minikube */}
          {!k8sStatus?.healthy && k8sStatus?.context === 'minikube' && (
            <Button
              onClick={handleStartMinikube}
              disabled={minikubeStarting}
              variant="outline"
              data-testid="k8s-start-minikube-btn"
            >
              {minikubeStarting ? (
                <>
                  <CircleNotch className="h-4 w-4 animate-spin" />
                  Starting Minikube...
                </>
              ) : (
                'Start Minikube'
              )}
            </Button>
          )}
          <div className="ml-auto">
            <SaveButton
              saving={isSavingDefaults}
              saved={defaultsSaved}
              onClick={saveDefaultSettings}
              testId="save-k8s-settings"
            />
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}
