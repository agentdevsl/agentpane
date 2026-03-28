import {
  CircleNotch,
  Cube,
  Gauge,
  Package,
  Warning,
  WifiHigh,
  WifiSlash,
} from '@phosphor-icons/react';
import { useCallback, useRef, useState } from 'react';
import { useInterval } from '@/app/hooks/use-interval';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type SandboxConfigItem } from '@/lib/api/client';
import type { SandboxProvider } from '@/lib/sandbox/types';
import { cn } from '@/lib/utils/cn';
import { ConfigEditor } from './config-editor.js';
import { ConfigList } from './config-list.js';
import { DefaultSettingsSection } from './default-settings.js';
import { K8sConfig } from './k8s-config.js';
import { NomadConfig } from './nomad-config.js';
import { ProviderSelector } from './provider-selector.js';
import {
  type ControllerStatus,
  type DefaultSandboxSettings,
  type EditorMode,
  getNomadStatusColor,
  getNomadStatusText,
  type K8sContext,
  K8sSettingsSchema,
  type K8sStatus,
  type NomadNamespace,
  NomadSettingsSchema,
  type NomadStatus,
  PROVIDER_LABELS,
  SaveButton,
} from './shared.js';

export function SandboxSettingsPage(): React.JSX.Element {
  const [configs, setConfigs] = useState<SandboxConfigItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Default project sandbox settings
  const [defaultSettings, setDefaultSettings] = useState<DefaultSandboxSettings>({
    enabled: false,
    provider: 'docker',
    memoryMb: 2048,
    cpuCores: 2,
    idleTimeoutMinutes: 30,
    image: '',
    namespace: 'default',
    containerMode: 'shared',
  });
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(true);
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);

  // Provider selection state
  const [selectedProvider, setSelectedProvider] = useState<SandboxProvider>('docker');
  const [isSavingProvider, setIsSavingProvider] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);

  // Timeout refs for cleanup on unmount
  const defaultsSavedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const providerSavedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useMountEffect(() => {
    return () => {
      clearTimeout(defaultsSavedTimerRef.current);
      clearTimeout(providerSavedTimerRef.current);
    };
  });

  // K8s configuration state
  const [k8sStatus, setK8sStatus] = useState<K8sStatus | null>(null);
  const [k8sStatusLoading, setK8sStatusLoading] = useState(false);
  const [k8sContexts, setK8sContexts] = useState<K8sContext[]>([]);
  const [k8sContextsLoading, setK8sContextsLoading] = useState(false);
  const [k8sConfigPath, setK8sConfigPath] = useState('');
  const [k8sContext, setK8sContext] = useState('');
  const [k8sNamespace, setK8sNamespace] = useState('agentpane-sandboxes');

  // Editor state
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editingConfig, setEditingConfig] = useState<SandboxConfigItem | null>(null);

  // CRD controller state
  const [controllerStatus, setControllerStatus] = useState<ControllerStatus | null>(null);
  const [controllerLoading, setControllerLoading] = useState(false);

  // Runtime class state
  const [runtimeClass, setRuntimeClass] = useState<'gvisor' | 'kata' | 'none'>('none');

  // TLS verification state
  const [skipTLSVerify, setSkipTLSVerify] = useState(true);

  // Warm pool state
  const [warmPoolEnabled, setWarmPoolEnabled] = useState(false);
  const [warmPoolSize, setWarmPoolSize] = useState(2);

  // Minikube autostart state
  const [autoStartMinikube, setAutoStartMinikube] = useState(false);

  // Auto-install CRDs state
  const [autoInstallCRDs, setAutoInstallCRDs] = useState(true);
  const [autoInstallingCRDs, setAutoInstallingCRDs] = useState(false);
  const lastAutoInstallAttemptRef = useRef(0);

  // Fallback to Docker state (global setting in sandbox.defaults)
  const [fallbackToDocker, setFallbackToDocker] = useState(false);

  // Minikube start action state
  const [minikubeStarting, setMinikubeStarting] = useState(false);

  // K8s initialization error state
  const [k8sInitError, setK8sInitError] = useState<{ error: string; timestamp: string } | null>(
    null
  );

  // Nomad configuration state
  const [nomadAddress, setNomadAddress] = useState('');
  const [nomadToken, setNomadToken] = useState('');
  const [nomadHasToken, setNomadHasToken] = useState(false);
  const [nomadTokenDirty, setNomadTokenDirty] = useState(false);
  const [nomadNamespace, setNomadNamespace] = useState('default');
  const [nomadRegion, setNomadRegion] = useState('');
  const [nomadDatacenter, setNomadDatacenter] = useState('');
  const [nomadSkipTLSVerify, setNomadSkipTLSVerify] = useState(false);
  const [nomadStatus, setNomadStatus] = useState<NomadStatus | null>(null);
  const [nomadStatusLoading, setNomadStatusLoading] = useState(false);
  const [nomadNamespaces, setNomadNamespaces] = useState<NomadNamespace[]>([]);
  const [nomadDatacenters, setNomadDatacenters] = useState<string[]>([]);
  const [nomadError, setNomadError] = useState<string | null>(null);
  const [nomadInitError, setNomadInitError] = useState<{
    error: string;
    timestamp: string;
  } | null>(null);

  const loadConfigs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiClient.sandboxConfigs.list();
      if (result.ok) {
        setConfigs(result.data.items);
      } else {
        setError(result.error.message);
      }
    } catch (_err) {
      setError('Failed to load sandbox configurations');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load default sandbox settings from settings API
  const loadDefaultSettings = useCallback(async () => {
    setIsLoadingDefaults(true);
    try {
      const result = await apiClient.settings.get([
        'sandbox.defaults',
        'sandbox.kubernetes',
        'sandbox.kubernetes.lastError',
        'sandbox.nomad',
        'sandbox.nomad.lastError',
      ]);
      if (result.ok) {
        // Load default settings
        if (result.data.settings['sandbox.defaults']) {
          const saved = result.data.settings['sandbox.defaults'] as DefaultSandboxSettings;
          setDefaultSettings(saved);
          // Sync provider selection with defaults
          if (saved.provider) {
            setSelectedProvider(saved.provider);
          }
          // Load global fallback setting
          if (saved.fallbackToDocker !== undefined) {
            setFallbackToDocker(saved.fallbackToDocker);
          }
        }

        // Load K8s-specific settings
        if (result.data.settings['sandbox.kubernetes']) {
          const parsed = K8sSettingsSchema.safeParse(result.data.settings['sandbox.kubernetes']);
          if (parsed.success) {
            const k8s = parsed.data;
            if (k8s.namespace) setK8sNamespace(k8s.namespace);
            if (k8s.kubeConfigPath) setK8sConfigPath(k8s.kubeConfigPath);
            if (k8s.kubeContext) setK8sContext(k8s.kubeContext);
            if (k8s.enableWarmPool !== undefined) setWarmPoolEnabled(k8s.enableWarmPool);
            if (k8s.warmPoolSize !== undefined) setWarmPoolSize(k8s.warmPoolSize);
            if (k8s.runtimeClassName) setRuntimeClass(k8s.runtimeClassName);
            if (k8s.skipTLSVerify !== undefined) setSkipTLSVerify(k8s.skipTLSVerify);
            if (k8s.autoStartMinikube !== undefined) setAutoStartMinikube(k8s.autoStartMinikube);
            if (k8s.autoInstallCRDs !== undefined) setAutoInstallCRDs(k8s.autoInstallCRDs);
          } else {
            console.warn('Invalid sandbox.kubernetes settings:', parsed.error.issues);
          }
        }

        // Load K8s initialization error
        if (result.data.settings['sandbox.kubernetes.lastError']) {
          const lastError = result.data.settings['sandbox.kubernetes.lastError'] as {
            error: string;
            timestamp: string;
          };
          setK8sInitError(lastError);
        } else {
          setK8sInitError(null);
        }

        // Load Nomad-specific settings
        if (result.data.settings['sandbox.nomad']) {
          const parsed = NomadSettingsSchema.safeParse(result.data.settings['sandbox.nomad']);
          if (parsed.success) {
            const nomad = parsed.data;
            if (nomad.address) setNomadAddress(nomad.address);
            // Server redacts the token (returns hasToken: true instead)
            // Only set nomadToken if a real token value was returned (shouldn't happen normally)
            if (nomad.token) setNomadToken(nomad.token);
            if ((result.data.settings['sandbox.nomad'] as Record<string, unknown>)?.hasToken) {
              setNomadHasToken(true);
            }
            if (nomad.namespace) setNomadNamespace(nomad.namespace);
            if (nomad.region) setNomadRegion(nomad.region);
            if (nomad.datacenter) setNomadDatacenter(nomad.datacenter);
            if (nomad.skipTLSVerify !== undefined) setNomadSkipTLSVerify(nomad.skipTLSVerify);
          }
        }

        // Load Nomad initialization error
        if (result.data.settings['sandbox.nomad.lastError']) {
          const lastError = result.data.settings['sandbox.nomad.lastError'] as {
            error: string;
            timestamp: string;
          };
          setNomadInitError(lastError);
        } else {
          setNomadInitError(null);
        }
      }
    } catch (loadErr) {
      console.error('[SandboxSettings] Failed to load default settings:', loadErr);
      setError('Failed to load settings. Your saved configuration may not be displayed correctly.');
    } finally {
      setIsLoadingDefaults(false);
    }
  }, []);

  // Save default sandbox settings
  const saveDefaultSettings = async () => {
    setIsSavingDefaults(true);
    try {
      const settingsToSave: Record<string, unknown> = {
        'sandbox.defaults': { ...defaultSettings, fallbackToDocker },
        // Also save container mode separately for container-agent.service to read
        'sandbox.mode': defaultSettings.containerMode ?? 'shared',
      };

      // If Kubernetes is selected, also persist K8s-specific settings
      if (defaultSettings.provider === 'kubernetes') {
        settingsToSave['sandbox.kubernetes'] = {
          namespace: k8sNamespace || 'agentpane-sandboxes',
          kubeConfigPath: k8sConfigPath || undefined,
          kubeContext: k8sContext || undefined,
          enableWarmPool: warmPoolEnabled,
          warmPoolSize,
          runtimeClassName: runtimeClass,
          skipTLSVerify,
          autoStartMinikube,
          autoInstallCRDs,
        };
      }

      // If Nomad is selected, also persist Nomad-specific settings
      if (defaultSettings.provider === 'nomad') {
        settingsToSave['sandbox.nomad'] = {
          address: nomadAddress || undefined,
          ...(nomadTokenDirty && { token: nomadToken || undefined }),
          namespace: nomadNamespace || 'default',
          region: nomadRegion || undefined,
          datacenter: nomadDatacenter || undefined,
          skipTLSVerify: nomadSkipTLSVerify,
        };
      }

      const result = await apiClient.settings.update(settingsToSave);
      if (result.ok) {
        setDefaultsSaved(true);
        if (nomadTokenDirty) {
          setNomadTokenDirty(false);
          setNomadHasToken(!!nomadToken);
        }
        defaultsSavedTimerRef.current = setTimeout(() => setDefaultsSaved(false), 2000);
      } else {
        setError('Failed to save default settings');
      }
    } catch (_err) {
      setError('Failed to save default settings');
    } finally {
      setIsSavingDefaults(false);
    }
  };

  useWatchEffect(() => {
    loadConfigs();
    loadDefaultSettings();
  }, [loadConfigs, loadDefaultSettings]);

  // Load K8s status when provider is selected
  const loadK8sStatus = useCallback(async () => {
    setK8sStatusLoading(true);
    setControllerLoading(true);

    try {
      const params = new URLSearchParams();
      if (k8sConfigPath) params.set('kubeconfigPath', k8sConfigPath);
      if (k8sContext) params.set('context', k8sContext);
      if (skipTLSVerify) params.set('skipTLSVerify', 'true');

      // Run cluster status + controller status checks in parallel
      const [statusResponse, controllerResponse] = await Promise.all([
        fetch(`/api/sandbox/k8s/status?${params.toString()}`),
        fetch(`/api/sandbox/k8s/controller?${params.toString()}`),
      ]);

      const statusResult = await statusResponse.json();
      const controllerResult = await controllerResponse.json();

      // Update cluster status
      if (statusResult.ok) {
        setK8sStatus(statusResult.data);
      } else {
        setK8sStatus({
          healthy: false,
          message: statusResult.error?.message ?? 'Failed to connect to cluster',
        });
      }

      // Update controller status
      if (controllerResult.ok) {
        setControllerStatus(controllerResult.data);
      } else {
        // API error — cluster likely unreachable
        setControllerStatus({ installed: false, clusterVersion: null });
      }
    } catch (_err) {
      setK8sStatus({
        healthy: false,
        message: 'Failed to check cluster status',
      });
      setControllerStatus({ installed: false, clusterVersion: null });
    } finally {
      setK8sStatusLoading(false);
      setControllerLoading(false);
    }
  }, [k8sConfigPath, k8sContext, skipTLSVerify]);

  // Load K8s contexts
  const loadK8sContexts = useCallback(async () => {
    setK8sContextsLoading(true);
    try {
      const params = new URLSearchParams();
      if (k8sConfigPath) params.set('kubeconfigPath', k8sConfigPath);

      const response = await fetch(`/api/sandbox/k8s/contexts?${params.toString()}`);
      const result = await response.json();

      if (result.ok) {
        setK8sContexts(result.data.contexts);
        // Set current context if not already set
        if (!k8sContext && result.data.current) {
          setK8sContext(result.data.current);
        }
      } else {
        setK8sContexts([]);
      }
    } catch (_err) {
      setK8sContexts([]);
    } finally {
      setK8sContextsLoading(false);
    }
  }, [k8sConfigPath, k8sContext]);

  // Load K8s info when provider changes to kubernetes
  useWatchEffect(() => {
    if (selectedProvider === 'kubernetes') {
      loadK8sContexts();
      loadK8sStatus();
    }
  }, [selectedProvider, loadK8sContexts, loadK8sStatus]);

  // Auto-install CRDs when CRDs are missing but cluster is reachable.
  // Uses a 60-second cooldown to prevent infinite retry loops.
  useWatchEffect(() => {
    if (
      autoInstallCRDs &&
      !controllerLoading &&
      controllerStatus &&
      !controllerStatus.crdReady &&
      controllerStatus.clusterVersion &&
      !autoInstallingCRDs &&
      Date.now() - lastAutoInstallAttemptRef.current > 60_000
    ) {
      lastAutoInstallAttemptRef.current = Date.now();
      const installCRDs = async () => {
        setAutoInstallingCRDs(true);
        try {
          const body: Record<string, unknown> = {};
          if (k8sConfigPath) body.kubeconfigPath = k8sConfigPath;
          if (k8sContext) body.context = k8sContext;
          if (skipTLSVerify) body.skipTLSVerify = true;

          const res = await fetch('/api/sandbox/k8s/install-crds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const result = await res.json();

          if (result.ok) {
            // Re-check controller status after installation
            await loadK8sStatus();
          } else {
            console.warn('Auto-install CRDs failed:', result.error?.message ?? 'Unknown error');
          }
        } catch (err) {
          console.warn('Auto-install CRDs failed:', err);
        } finally {
          setAutoInstallingCRDs(false);
        }
      };
      installCRDs();
    }
  }, [
    autoInstallCRDs,
    controllerLoading,
    controllerStatus,
    autoInstallingCRDs,
    k8sConfigPath,
    k8sContext,
    skipTLSVerify,
    loadK8sStatus,
  ]);

  // Periodic K8s status polling for real-time auto-heal feedback
  useInterval(loadK8sStatus, selectedProvider === 'kubernetes' ? 30_000 : null);

  // Start minikube manually from the UI
  const handleStartMinikube = async () => {
    setMinikubeStarting(true);
    try {
      const params = new URLSearchParams();
      if (k8sConfigPath) params.set('kubeconfigPath', k8sConfigPath);
      if (k8sContext) params.set('context', k8sContext);
      const query = params.toString();
      const res = await fetch(`/api/sandbox/k8s/minikube/start${query ? `?${query}` : ''}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.ok && data.data?.started) {
        // Refresh status after minikube starts
        await loadK8sStatus();
      } else {
        setError(data.data?.message ?? data.error?.message ?? 'Failed to start minikube');
      }
    } catch (_err) {
      setError('Failed to start minikube');
    } finally {
      setMinikubeStarting(false);
    }
  };

  // Nomad API functions
  const loadNomadStatus = useCallback(async () => {
    const unhealthy = {
      healthy: false,
      leader: null,
      version: null,
      datacenter: null,
      jobCount: 0,
    } as const;
    setNomadStatusLoading(true);
    try {
      const res = await fetch('/api/sandbox/nomad/status');
      const data = await res.json();
      if (data.ok) {
        setNomadStatus(data.data);
        setNomadError(null);
      } else {
        setNomadStatus(unhealthy);
        setNomadError(data.error?.message ?? 'Failed to connect to Nomad');
      }
    } catch (_err) {
      setNomadStatus(unhealthy);
      setNomadError('Failed to check Nomad status');
    } finally {
      setNomadStatusLoading(false);
    }
  }, []);

  const loadNomadNamespaces = useCallback(async () => {
    try {
      const res = await fetch('/api/sandbox/nomad/namespaces');
      const data = await res.json();
      if (data.ok) {
        setNomadNamespaces(data.data.namespaces ?? []);
      }
    } catch (err) {
      console.error('[SandboxSettings] Failed to load Nomad namespaces:', err);
      setNomadNamespaces([]);
      setNomadError('Failed to load namespaces from Nomad cluster');
    }
  }, []);

  const loadNomadDatacenters = useCallback(async () => {
    try {
      const res = await fetch('/api/sandbox/nomad/datacenters');
      const data = await res.json();
      if (data.ok) {
        setNomadDatacenters(data.data.datacenters ?? []);
      }
    } catch (err) {
      console.error('[SandboxSettings] Failed to load Nomad datacenters:', err);
      setNomadDatacenters([]);
      setNomadError('Failed to load datacenters from Nomad cluster');
    }
  }, []);

  // Load Nomad info when provider changes to nomad
  useWatchEffect(() => {
    if (selectedProvider === 'nomad') {
      loadNomadStatus();
      loadNomadNamespaces();
      loadNomadDatacenters();
    }
  }, [selectedProvider, loadNomadStatus, loadNomadNamespaces, loadNomadDatacenters]);

  // Periodic Nomad status polling
  useInterval(loadNomadStatus, selectedProvider === 'nomad' ? 30_000 : null);

  const handleSaveProvider = async () => {
    setIsSavingProvider(true);
    try {
      await saveDefaultSettings();
      setProviderSaved(true);
      providerSavedTimerRef.current = setTimeout(() => setProviderSaved(false), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save provider settings';
      setError(message);
    } finally {
      setIsSavingProvider(false);
    }
  };

  const openCreateEditor = () => {
    setEditorMode('create');
    setEditingConfig(null);
  };

  const openEditEditor = (config: SandboxConfigItem) => {
    setEditorMode('edit');
    setEditingConfig(config);
  };

  const closeEditor = () => {
    setEditorMode(null);
    setEditingConfig(null);
  };

  const handleDelete = async (config: SandboxConfigItem) => {
    if (!confirm(`Delete sandbox configuration "${config.name}"?`)) {
      return;
    }

    try {
      const result = await apiClient.sandboxConfigs.delete(config.id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await loadConfigs();
    } catch (_err) {
      setError('Failed to delete configuration');
    }
  };

  return (
    <div data-testid="sandbox-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header with gradient accent - matching gold standard */}
      <header className="relative mb-10">
        {/* Decorative background elements */}
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20">
              <Package className="h-6 w-6 text-accent" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">
                Sandbox Configuration
              </h1>
              <p className="text-sm text-fg-muted">
                Configure execution environments for AI agents
              </p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Cube className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                Provider:{' '}
                <span className="font-medium text-fg">
                  {PROVIDER_LABELS[selectedProvider] ?? selectedProvider}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-attention-fg" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{configs.length}</span> profile
                {configs.length !== 1 ? 's' : ''}
              </span>
            </div>
            {selectedProvider === 'kubernetes' && (
              <div className="flex items-center gap-2">
                {k8sStatusLoading ? (
                  <CircleNotch className="h-4 w-4 animate-spin text-fg-subtle" />
                ) : k8sStatus?.healthy ? (
                  <WifiHigh className="h-4 w-4 text-success" />
                ) : (
                  <WifiSlash className="h-4 w-4 text-danger" />
                )}
                <span className="text-xs text-fg-muted">
                  Status:{' '}
                  <span
                    className={cn(
                      'font-medium',
                      k8sStatus?.healthy ? 'text-success' : 'text-danger'
                    )}
                  >
                    {k8sStatusLoading
                      ? 'Checking...'
                      : k8sStatus?.healthy
                        ? 'Connected'
                        : 'Disconnected'}
                  </span>
                </span>
              </div>
            )}
            {selectedProvider === 'nomad' && (
              <div className="flex items-center gap-2">
                {nomadStatusLoading ? (
                  <CircleNotch className="h-4 w-4 animate-spin text-fg-subtle" />
                ) : nomadStatus?.healthy ? (
                  <WifiHigh className="h-4 w-4 text-success" />
                ) : (
                  <WifiSlash
                    className={cn(
                      'h-4 w-4',
                      nomadStatus === null ? 'text-fg-muted' : 'text-danger'
                    )}
                  />
                )}
                <span className="text-xs text-fg-muted">
                  Status:{' '}
                  <span
                    className={cn(
                      'font-medium',
                      getNomadStatusColor(nomadStatusLoading, nomadStatus)
                    )}
                  >
                    {getNomadStatusText(nomadStatusLoading, nomadStatus)}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Error display */}
      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <Warning className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-5">
        {/* Default Project Sandbox Settings */}
        <DefaultSettingsSection
          defaultSettings={defaultSettings}
          setDefaultSettings={setDefaultSettings}
          setSelectedProvider={setSelectedProvider}
          isLoadingDefaults={isLoadingDefaults}
          isSavingDefaults={isSavingDefaults}
          defaultsSaved={defaultsSaved}
          saveDefaultSettings={saveDefaultSettings}
        />

        {/* Provider Selection Section */}
        <ProviderSelector
          selectedProvider={selectedProvider}
          setSelectedProvider={setSelectedProvider}
          setDefaultSettings={setDefaultSettings}
        />

        {/* Kubernetes Configuration Section - Only shown when K8s selected */}
        {selectedProvider === 'kubernetes' && (
          <K8sConfig
            k8sStatus={k8sStatus}
            k8sStatusLoading={k8sStatusLoading}
            k8sContexts={k8sContexts}
            k8sContextsLoading={k8sContextsLoading}
            k8sConfigPath={k8sConfigPath}
            setK8sConfigPath={setK8sConfigPath}
            k8sContext={k8sContext}
            setK8sContext={setK8sContext}
            k8sNamespace={k8sNamespace}
            setK8sNamespace={setK8sNamespace}
            runtimeClass={runtimeClass}
            setRuntimeClass={setRuntimeClass}
            skipTLSVerify={skipTLSVerify}
            setSkipTLSVerify={setSkipTLSVerify}
            warmPoolEnabled={warmPoolEnabled}
            setWarmPoolEnabled={setWarmPoolEnabled}
            warmPoolSize={warmPoolSize}
            setWarmPoolSize={setWarmPoolSize}
            autoInstallCRDs={autoInstallCRDs}
            setAutoInstallCRDs={setAutoInstallCRDs}
            autoInstallingCRDs={autoInstallingCRDs}
            autoStartMinikube={autoStartMinikube}
            setAutoStartMinikube={setAutoStartMinikube}
            fallbackToDocker={fallbackToDocker}
            setFallbackToDocker={setFallbackToDocker}
            controllerStatus={controllerStatus}
            controllerLoading={controllerLoading}
            k8sInitError={k8sInitError}
            minikubeStarting={minikubeStarting}
            handleStartMinikube={handleStartMinikube}
            loadK8sStatus={loadK8sStatus}
            isSavingDefaults={isSavingDefaults}
            defaultsSaved={defaultsSaved}
            saveDefaultSettings={saveDefaultSettings}
          />
        )}

        {/* Nomad Configuration Section - Only shown when Nomad selected */}
        {selectedProvider === 'nomad' && (
          <NomadConfig
            nomadAddress={nomadAddress}
            setNomadAddress={setNomadAddress}
            nomadToken={nomadToken}
            setNomadToken={setNomadToken}
            nomadHasToken={nomadHasToken}
            nomadTokenDirty={nomadTokenDirty}
            setNomadTokenDirty={setNomadTokenDirty}
            nomadNamespace={nomadNamespace}
            setNomadNamespace={setNomadNamespace}
            nomadRegion={nomadRegion}
            setNomadRegion={setNomadRegion}
            nomadDatacenter={nomadDatacenter}
            setNomadDatacenter={setNomadDatacenter}
            nomadSkipTLSVerify={nomadSkipTLSVerify}
            setNomadSkipTLSVerify={setNomadSkipTLSVerify}
            nomadStatus={nomadStatus}
            nomadStatusLoading={nomadStatusLoading}
            nomadNamespaces={nomadNamespaces}
            nomadDatacenters={nomadDatacenters}
            nomadError={nomadError}
            nomadInitError={nomadInitError}
            loadNomadStatus={loadNomadStatus}
            isSavingDefaults={isSavingDefaults}
            defaultsSaved={defaultsSaved}
            saveDefaultSettings={saveDefaultSettings}
          />
        )}

        {/* Resource Profiles Section */}
        <ConfigList
          configs={configs}
          isLoading={isLoading}
          openCreateEditor={openCreateEditor}
          openEditEditor={openEditEditor}
          handleDelete={handleDelete}
        />

        {/* Sticky Save Footer */}
        <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-border bg-surface/95 px-5 py-4 shadow-lg backdrop-blur-sm">
          <p className="text-sm text-fg-muted">Provider settings</p>
          <SaveButton
            saving={isSavingProvider}
            saved={providerSaved}
            onClick={handleSaveProvider}
            testId="save-provider-settings"
          />
        </div>
      </div>

      {/* Editor modal */}
      <ConfigEditor
        editorMode={editorMode}
        editingConfig={editingConfig}
        closeEditor={closeEditor}
        loadConfigs={loadConfigs}
      />
    </div>
  );
}
