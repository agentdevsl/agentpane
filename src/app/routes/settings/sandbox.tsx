import {
  Check,
  CircleNotch,
  Cloud,
  CloudArrowUp,
  Cpu,
  Cube,
  FolderOpen,
  Gauge,
  HardDrive,
  Package,
  Pencil,
  Plus,
  Sliders,
  Timer,
  Trash,
  TreeStructure,
  Warning,
  WifiHigh,
  WifiSlash,
  X,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import {
  apiClient,
  type CreateSandboxConfigInput,
  type SandboxConfigItem,
  type UpdateSandboxConfigInput,
} from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

type SandboxProvider = 'docker' | 'devcontainer' | 'kubernetes';

// Sandbox container mode: shared or per-project
type SandboxContainerMode = 'shared' | 'per-project';

// Default project sandbox settings that projects inherit
interface DefaultSandboxSettings {
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

interface K8sStatus {
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

interface K8sContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
}

const K8sSettingsSchema = z.object({
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

export const Route = createFileRoute('/settings/sandbox')({
  component: SandboxSettingsPage,
});

type EditorMode = 'create' | 'edit' | null;

function SandboxSettingsPage(): React.JSX.Element {
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
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formType, setFormType] = useState<'docker' | 'devcontainer' | 'kubernetes'>('docker');
  const [formBaseImage, setFormBaseImage] = useState('node:22-slim');
  const [formMemoryMb, setFormMemoryMb] = useState(4096);
  const [formCpuCores, setFormCpuCores] = useState(2.0);
  const [formMaxProcesses, setFormMaxProcesses] = useState(256);
  const [formTimeoutMinutes, setFormTimeoutMinutes] = useState(60);
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formVolumeMountPath, setFormVolumeMountPath] = useState('');
  // K8s form state
  const [formKubeConfigPath, setFormKubeConfigPath] = useState('');
  const [formKubeContext, setFormKubeContext] = useState('');
  const [formKubeNamespace, setFormKubeNamespace] = useState('agentpane-sandboxes');

  // CRD controller state
  const [controllerStatus, setControllerStatus] = useState<{
    installed: boolean;
    version?: string;
    crdRegistered?: boolean;
    crdApiVersion?: string;
    clusterVersion?: string | null;
    ready?: boolean;
  } | null>(null);
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
  const [autoInstallCRDs, setAutoInstallCRDs] = useState(false);

  // Fallback to Docker state (global setting in sandbox.defaults)
  const [fallbackToDocker, setFallbackToDocker] = useState(false);

  // Minikube start action state
  const [minikubeStarting, setMinikubeStarting] = useState(false);

  // K8s initialization error state
  const [k8sInitError, setK8sInitError] = useState<{ error: string; timestamp: string } | null>(
    null
  );

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
      }
    } catch (_err) {
      // Use defaults if not set
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

      const result = await apiClient.settings.update(settingsToSave);
      if (result.ok) {
        setDefaultsSaved(true);
        setTimeout(() => setDefaultsSaved(false), 2000);
      }
    } catch (_err) {
      setError('Failed to save default settings');
    } finally {
      setIsSavingDefaults(false);
    }
  };

  useEffect(() => {
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
  useEffect(() => {
    if (selectedProvider === 'kubernetes') {
      loadK8sContexts();
      loadK8sStatus();
    }
  }, [selectedProvider, loadK8sContexts, loadK8sStatus]);

  // Start minikube manually from the UI
  const handleStartMinikube = async () => {
    setMinikubeStarting(true);
    try {
      const params = new URLSearchParams();
      if (k8sConfigPath) params.set('kubeconfigPath', k8sConfigPath);
      if (k8sContext) params.set('context', k8sContext);
      const query = params.toString();
      const res = await fetch(
        `http://localhost:3001/api/sandbox/k8s/minikube/start${query ? `?${query}` : ''}`,
        {
          method: 'POST',
        }
      );
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

  const handleSaveProvider = async () => {
    setIsSavingProvider(true);
    // TODO: Implement provider persistence via settings API
    await new Promise((resolve) => setTimeout(resolve, 500));
    setProviderSaved(true);
    setTimeout(() => setProviderSaved(false), 2000);
    setIsSavingProvider(false);
  };

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormType('docker');
    setFormBaseImage('node:22-slim');
    setFormMemoryMb(4096);
    setFormCpuCores(2.0);
    setFormMaxProcesses(256);
    setFormTimeoutMinutes(60);
    setFormIsDefault(false);
    setFormVolumeMountPath('');
    // K8s form fields
    setFormKubeConfigPath('');
    setFormKubeContext('');
    setFormKubeNamespace('agentpane-sandboxes');
    setSaveError(null);
  };

  const openCreateEditor = () => {
    resetForm();
    setEditorMode('create');
    setEditingConfig(null);
  };

  const openEditEditor = (config: SandboxConfigItem) => {
    setFormName(config.name);
    setFormDescription(config.description ?? '');
    setFormType((config.type as 'docker' | 'devcontainer' | 'kubernetes') ?? 'docker');
    setFormBaseImage(config.baseImage);
    setFormMemoryMb(config.memoryMb);
    setFormCpuCores(config.cpuCores);
    setFormMaxProcesses(config.maxProcesses);
    setFormTimeoutMinutes(config.timeoutMinutes);
    setFormIsDefault(config.isDefault);
    setFormVolumeMountPath(config.volumeMountPath ?? '');
    // K8s fields
    setFormKubeConfigPath((config as { kubeConfigPath?: string }).kubeConfigPath ?? '');
    setFormKubeContext((config as { kubeContext?: string }).kubeContext ?? '');
    setFormKubeNamespace(
      (config as { kubeNamespace?: string }).kubeNamespace ?? 'agentpane-sandboxes'
    );
    setSaveError(null);
    setEditorMode('edit');
    setEditingConfig(config);
  };

  const closeEditor = () => {
    setEditorMode(null);
    setEditingConfig(null);
    resetForm();
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      setSaveError('Name is required');
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      if (editorMode === 'create') {
        const input: CreateSandboxConfigInput = {
          name: formName,
          description: formDescription || undefined,
          type: formType,
          baseImage: formBaseImage,
          memoryMb: formMemoryMb,
          cpuCores: formCpuCores,
          maxProcesses: formMaxProcesses,
          timeoutMinutes: formTimeoutMinutes,
          isDefault: formIsDefault,
          volumeMountPath: formVolumeMountPath || undefined,
          // K8s fields
          kubeConfigPath: formKubeConfigPath || undefined,
          kubeContext: formKubeContext || undefined,
          kubeNamespace: formKubeNamespace || undefined,
        };
        const result = await apiClient.sandboxConfigs.create(input);
        if (!result.ok) {
          setSaveError(result.error.message);
          return;
        }
      } else if (editorMode === 'edit' && editingConfig) {
        const input: UpdateSandboxConfigInput = {
          name: formName,
          description: formDescription || undefined,
          type: formType,
          baseImage: formBaseImage,
          memoryMb: formMemoryMb,
          cpuCores: formCpuCores,
          maxProcesses: formMaxProcesses,
          timeoutMinutes: formTimeoutMinutes,
          isDefault: formIsDefault,
          volumeMountPath: formVolumeMountPath || undefined,
          // K8s fields
          kubeConfigPath: formKubeConfigPath || undefined,
          kubeContext: formKubeContext || undefined,
          kubeNamespace: formKubeNamespace || undefined,
        };
        const result = await apiClient.sandboxConfigs.update(editingConfig.id, input);
        if (!result.ok) {
          setSaveError(result.error.message);
          return;
        }
      }

      closeEditor();
      await loadConfigs();
    } catch (_err) {
      setSaveError('Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
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
                  {selectedProvider === 'docker' ? 'Docker' : 'Kubernetes'}
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
        {/* Default Project Sandbox Settings - The main configuration */}
        <ConfigSection
          icon={Sliders}
          title="Default Project Settings"
          description="These settings are inherited by all new projects. Individual projects can override them."
          badge={defaultSettings.enabled ? 'Enabled' : 'Disabled'}
          badgeColor={defaultSettings.enabled ? 'success' : 'accent'}
          testId="default-settings-section"
        >
          {isLoadingDefaults ? (
            <div className="flex items-center justify-center py-8">
              <CircleNotch className="h-6 w-6 animate-spin text-fg-muted" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Enable toggle */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                      defaultSettings.enabled
                        ? 'bg-success/20 text-success'
                        : 'bg-surface-muted text-fg-muted'
                    )}
                  >
                    <Cube
                      className="h-5 w-5"
                      weight={defaultSettings.enabled ? 'fill' : 'regular'}
                    />
                  </div>
                  <div>
                    <p className="font-medium text-fg">Enable Sandbox by Default</p>
                    <p className="text-sm text-fg-muted">
                      {defaultSettings.enabled
                        ? 'New projects will use sandbox execution'
                        : 'Projects use host execution by default'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={defaultSettings.enabled}
                  onClick={() =>
                    setDefaultSettings((prev) => ({ ...prev, enabled: !prev.enabled }))
                  }
                  className={cn(
                    'relative h-6 w-11 rounded-full transition-colors',
                    defaultSettings.enabled ? 'bg-success' : 'bg-surface-muted'
                  )}
                  data-testid="default-sandbox-enabled-toggle"
                >
                  <span
                    className={cn(
                      'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                      defaultSettings.enabled ? 'translate-x-5' : 'translate-x-0'
                    )}
                  />
                </button>
              </div>

              {/* Provider selection */}
              <div
                className={cn(
                  'transition-opacity',
                  defaultSettings.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
                )}
              >
                <p className="mb-3 text-sm font-medium text-fg">Default Provider</p>
                <div className="grid grid-cols-3 gap-3">
                  {/* Docker */}
                  <button
                    type="button"
                    onClick={() => {
                      setDefaultSettings((prev) => ({ ...prev, provider: 'docker' }));
                      setSelectedProvider('docker');
                    }}
                    className={cn(
                      'relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all',
                      defaultSettings.provider === 'docker'
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="default-provider-docker"
                  >
                    <span className="text-2xl">🐳</span>
                    <span
                      className={cn(
                        'text-sm font-medium',
                        defaultSettings.provider === 'docker' ? 'text-accent' : 'text-fg'
                      )}
                    >
                      Docker
                    </span>
                    <span className="text-xs text-fg-muted">Local containers</span>
                    {defaultSettings.provider === 'docker' && (
                      <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                    )}
                  </button>

                  {/* DevContainer */}
                  <button
                    type="button"
                    onClick={() => {
                      setDefaultSettings((prev) => ({ ...prev, provider: 'devcontainer' }));
                      setSelectedProvider('devcontainer');
                    }}
                    className={cn(
                      'relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all',
                      defaultSettings.provider === 'devcontainer'
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="default-provider-devcontainer"
                  >
                    <span className="text-2xl">📦</span>
                    <span
                      className={cn(
                        'text-sm font-medium',
                        defaultSettings.provider === 'devcontainer' ? 'text-accent' : 'text-fg'
                      )}
                    >
                      DevContainer
                    </span>
                    <span className="text-xs text-fg-muted">VS Code compatible</span>
                    {defaultSettings.provider === 'devcontainer' && (
                      <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                    )}
                  </button>

                  {/* Kubernetes */}
                  <button
                    type="button"
                    onClick={() => {
                      setDefaultSettings((prev) => ({ ...prev, provider: 'kubernetes' }));
                      setSelectedProvider('kubernetes');
                    }}
                    className={cn(
                      'relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all',
                      defaultSettings.provider === 'kubernetes'
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-fg-subtle'
                    )}
                    data-testid="default-provider-kubernetes"
                  >
                    <span className="text-2xl">☸️</span>
                    <span
                      className={cn(
                        'text-sm font-medium',
                        defaultSettings.provider === 'kubernetes' ? 'text-accent' : 'text-fg'
                      )}
                    >
                      Kubernetes
                    </span>
                    <span className="text-xs text-fg-muted">Cluster pods</span>
                    {defaultSettings.provider === 'kubernetes' && (
                      <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                    )}
                  </button>
                </div>
              </div>

              {/* Resource settings */}
              <div
                className={cn(
                  'grid gap-4 sm:grid-cols-2 lg:grid-cols-4 transition-opacity',
                  defaultSettings.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
                )}
              >
                {/* Memory */}
                <div className="rounded-lg border border-border bg-surface-subtle p-4">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    <HardDrive className="h-4 w-4" />
                    Memory
                  </div>
                  <select
                    value={defaultSettings.memoryMb}
                    onChange={(e) =>
                      setDefaultSettings((prev) => ({ ...prev, memoryMb: Number(e.target.value) }))
                    }
                    className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    data-testid="default-memory-select"
                  >
                    <option value="1024">1 GB</option>
                    <option value="2048">2 GB</option>
                    <option value="4096">4 GB</option>
                    <option value="8192">8 GB</option>
                  </select>
                </div>

                {/* CPU */}
                <div className="rounded-lg border border-border bg-surface-subtle p-4">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    <Cpu className="h-4 w-4" />
                    CPU Cores
                  </div>
                  <select
                    value={defaultSettings.cpuCores}
                    onChange={(e) =>
                      setDefaultSettings((prev) => ({ ...prev, cpuCores: Number(e.target.value) }))
                    }
                    className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    data-testid="default-cpu-select"
                  >
                    <option value="1">1 core</option>
                    <option value="2">2 cores</option>
                    <option value="4">4 cores</option>
                  </select>
                </div>

                {/* Timeout */}
                <div className="rounded-lg border border-border bg-surface-subtle p-4">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    <Timer className="h-4 w-4" />
                    Idle Timeout
                  </div>
                  <select
                    value={defaultSettings.idleTimeoutMinutes}
                    onChange={(e) =>
                      setDefaultSettings((prev) => ({
                        ...prev,
                        idleTimeoutMinutes: Number(e.target.value),
                      }))
                    }
                    className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    data-testid="default-timeout-select"
                  >
                    <option value="10">10 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                  </select>
                </div>

                {/* K8s Namespace - only shown for kubernetes */}
                {defaultSettings.provider === 'kubernetes' && (
                  <div className="rounded-lg border border-border bg-surface-subtle p-4">
                    <div className="flex items-center gap-2 text-sm text-fg-muted">
                      <Cloud className="h-4 w-4" />
                      Namespace
                    </div>
                    <input
                      type="text"
                      value={defaultSettings.namespace || ''}
                      onChange={(e) =>
                        setDefaultSettings((prev) => ({ ...prev, namespace: e.target.value }))
                      }
                      placeholder="default"
                      className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                      data-testid="default-namespace-input"
                    />
                  </div>
                )}
              </div>

              {/* Container Mode - Docker only */}
              {defaultSettings.provider === 'docker' && (
                <div
                  className={cn(
                    'transition-opacity',
                    defaultSettings.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
                  )}
                >
                  <p className="mb-3 text-sm font-medium text-fg">Container Mode</p>
                  <div className="grid grid-cols-2 gap-3">
                    {/* Shared Container */}
                    <button
                      type="button"
                      onClick={() =>
                        setDefaultSettings((prev) => ({ ...prev, containerMode: 'shared' }))
                      }
                      className={cn(
                        'relative flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all',
                        defaultSettings.containerMode === 'shared'
                          ? 'border-accent bg-accent/10'
                          : 'border-border hover:border-fg-subtle'
                      )}
                      data-testid="container-mode-shared"
                    >
                      <span className="text-xl">🔗</span>
                      <div>
                        <span
                          className={cn(
                            'text-sm font-medium',
                            defaultSettings.containerMode === 'shared' ? 'text-accent' : 'text-fg'
                          )}
                        >
                          Shared Container
                        </span>
                        <p className="mt-1 text-xs text-fg-muted">
                          One container for all projects. Simpler setup.
                        </p>
                      </div>
                      {defaultSettings.containerMode === 'shared' && (
                        <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                      )}
                    </button>

                    {/* Per-Project Container */}
                    <button
                      type="button"
                      onClick={() =>
                        setDefaultSettings((prev) => ({ ...prev, containerMode: 'per-project' }))
                      }
                      className={cn(
                        'relative flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all',
                        defaultSettings.containerMode === 'per-project'
                          ? 'border-accent bg-accent/10'
                          : 'border-border hover:border-fg-subtle'
                      )}
                      data-testid="container-mode-per-project"
                    >
                      <span className="text-xl">📁</span>
                      <div>
                        <span
                          className={cn(
                            'text-sm font-medium',
                            defaultSettings.containerMode === 'per-project'
                              ? 'text-accent'
                              : 'text-fg'
                          )}
                        >
                          Per-Project Container
                        </span>
                        <p className="mt-1 text-xs text-fg-muted">
                          Unique container per project with isolated mounts.
                        </p>
                      </div>
                      {defaultSettings.containerMode === 'per-project' && (
                        <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Save button */}
              <div className="flex justify-end">
                <Button
                  onClick={saveDefaultSettings}
                  disabled={isSavingDefaults}
                  className={cn(
                    'min-w-[140px] transition-all',
                    defaultsSaved && 'bg-success hover:bg-success'
                  )}
                  data-testid="save-default-settings"
                >
                  {isSavingDefaults ? (
                    <>
                      <CircleNotch className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : defaultsSaved ? (
                    <>
                      <Check className="h-4 w-4" weight="bold" />
                      Saved!
                    </>
                  ) : (
                    'Save Defaults'
                  )}
                </Button>
              </div>
            </div>
          )}
        </ConfigSection>

        {/* Provider Selection Section */}
        <ConfigSection
          icon={Cube}
          title="Provider Selection"
          description="Choose where agent code executes"
          badge={selectedProvider === 'docker' ? 'Docker' : 'K8s'}
          badgeColor="accent"
          testId="provider-section"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Docker Provider */}
            <button
              type="button"
              onClick={() => setSelectedProvider('docker')}
              className={cn(
                'relative cursor-pointer rounded-lg border-2 p-5 text-left transition-all',
                selectedProvider === 'docker'
                  ? 'border-accent bg-accent-muted/30'
                  : 'border-border hover:border-fg-subtle'
              )}
              data-testid="provider-docker"
            >
              {selectedProvider === 'docker' && (
                <div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent">
                  <Check className="h-3 w-3 text-white" weight="bold" />
                </div>
              )}
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-2xl">
                🐳
              </div>
              <h3 className="font-semibold text-fg">Docker</h3>
              <p className="mt-1 text-sm text-fg-muted">
                Local container isolation. Best for development.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-fg-muted">
                  Network Isolation
                </span>
                <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-fg-muted">
                  Resource Limits
                </span>
              </div>
            </button>

            {/* Kubernetes Provider */}
            <button
              type="button"
              onClick={() => setSelectedProvider('kubernetes')}
              className={cn(
                'relative cursor-pointer rounded-lg border-2 p-5 text-left transition-all',
                selectedProvider === 'kubernetes'
                  ? 'border-accent bg-accent-muted/30'
                  : 'border-border hover:border-fg-subtle'
              )}
              data-testid="provider-kubernetes"
            >
              {selectedProvider === 'kubernetes' && (
                <div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent">
                  <Check className="h-3 w-3 text-white" weight="bold" />
                </div>
              )}
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-2xl">
                ☸️
              </div>
              <h3 className="font-semibold text-fg">Kubernetes</h3>
              <p className="mt-1 text-sm text-fg-muted">
                Local K8s via minikube/kind. Production-like isolation.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-success-muted px-2.5 py-1 text-xs text-success">
                  Network Policies
                </span>
                <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-fg-muted">
                  Warm Pool
                </span>
              </div>
            </button>
          </div>
        </ConfigSection>

        {/* Kubernetes Configuration Section - Only shown when K8s selected */}
        {selectedProvider === 'kubernetes' && (
          <ConfigSection
            icon={CloudArrowUp}
            title="Kubernetes Configuration"
            description="Configure your Kubernetes cluster connection"
            badge={
              k8sStatus?.healthy ? 'Connected' : k8sStatus?.context ? 'Unreachable' : 'Disconnected'
            }
            badgeColor={k8sStatus?.healthy ? 'success' : 'accent'}
            testId="k8s-config-section"
          >
            <div className="space-y-6">
              {/* Cluster Status Indicator */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
                <div className="flex items-center gap-3">
                  {k8sStatusLoading ? (
                    <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />
                  ) : k8sStatus?.healthy ? (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success-muted">
                      <WifiHigh className="h-4 w-4 text-success" />
                    </div>
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-danger-muted">
                      <WifiSlash className="h-4 w-4 text-danger" />
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-fg">
                      {k8sStatusLoading
                        ? 'Checking connection...'
                        : k8sStatus?.healthy
                          ? 'Connected'
                          : 'Cluster Unreachable'}
                    </p>
                    {k8sStatus?.healthy && k8sStatus.cluster && (
                      <p className="text-xs text-fg-muted">
                        {k8sStatus.cluster} ({k8sStatus.serverVersion})
                      </p>
                    )}
                    {!k8sStatus?.healthy && k8sStatus?.context && (
                      <p className="text-xs text-fg-muted">Context: {k8sStatus.context}</p>
                    )}
                    {!k8sStatus?.healthy && k8sStatus?.message && (
                      <p className="text-xs text-danger">{k8sStatus.message}</p>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadK8sStatus}
                  disabled={k8sStatusLoading}
                  data-testid="refresh-k8s-status"
                >
                  {k8sStatusLoading ? <CircleNotch className="h-4 w-4 animate-spin" /> : 'Refresh'}
                </Button>
              </div>

              {/* CRD Controller Status */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
                <div className="flex items-center gap-3">
                  {controllerLoading ? (
                    <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />
                  ) : controllerStatus?.installed ? (
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
                        : controllerStatus?.installed
                          ? 'Agent Sandbox Controller'
                          : !controllerStatus?.clusterVersion
                            ? 'Cluster Unreachable'
                            : 'Controller Not Installed'}
                    </p>
                    {controllerStatus?.installed && (
                      <p className="text-xs text-fg-muted">
                        v{controllerStatus.version} &middot; CRD{' '}
                        {controllerStatus.crdApiVersion ?? 'v1alpha1'}
                      </p>
                    )}
                    {!controllerStatus?.installed &&
                      !controllerLoading &&
                      !controllerStatus?.clusterVersion && (
                        <p className="text-xs text-danger">
                          Cannot reach the Kubernetes cluster. Check that minikube or your cluster
                          is running.
                        </p>
                      )}
                    {!controllerStatus?.installed &&
                      !controllerLoading &&
                      controllerStatus?.clusterVersion && (
                        <p className="text-xs text-danger">
                          Install the Agent Sandbox CRD controller to use Kubernetes sandboxes
                        </p>
                      )}
                  </div>
                </div>
              </div>

              {/* K8s Form Fields */}
              <div className="space-y-4">
                {/* Kubeconfig Path */}
                <div>
                  <label
                    htmlFor="k8s-config-path"
                    className="mb-1.5 block text-sm font-medium text-fg"
                  >
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
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skipTLSVerify}
                    onClick={() => setSkipTLSVerify(!skipTLSVerify)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors',
                      skipTLSVerify ? 'bg-accent' : 'bg-fg-muted/30'
                    )}
                    data-testid="k8s-skip-tls-toggle"
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform mt-0.5',
                        skipTLSVerify ? 'translate-x-4' : 'translate-x-0.5'
                      )}
                    />
                  </button>
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
                  <label
                    htmlFor="k8s-namespace"
                    className="mb-1.5 block text-sm font-medium text-fg"
                  >
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
                  <label
                    htmlFor="k8s-runtime-class"
                    className="mb-1.5 block text-sm font-medium text-fg"
                  >
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
                    gVisor provides user-space kernel isolation with low overhead. Kata uses
                    lightweight VMs for stronger isolation. Default uses the cluster&apos;s standard
                    container runtime.
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
                          <span className="ml-1 text-warning">(will be created)</span>
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
                        warmPoolEnabled
                          ? 'bg-success/20 text-success'
                          : 'bg-surface-muted text-fg-muted'
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
                  <button
                    type="button"
                    role="switch"
                    aria-checked={warmPoolEnabled}
                    onClick={() => setWarmPoolEnabled(!warmPoolEnabled)}
                    className={cn(
                      'relative h-6 w-11 rounded-full transition-colors',
                      warmPoolEnabled ? 'bg-success' : 'bg-surface-muted'
                    )}
                    data-testid="k8s-warm-pool-toggle"
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                        warmPoolEnabled ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
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

              {/* K8s Initialization Error Banner */}
              {k8sInitError && (
                <div
                  className="rounded-lg border border-danger/30 bg-danger/10 p-4"
                  data-testid="k8s-init-error-banner"
                >
                  <div className="flex items-start gap-3">
                    <Warning className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" weight="fill" />
                    <div>
                      <p className="text-sm font-medium text-danger">
                        Kubernetes Initialization Failed
                      </p>
                      <p className="mt-1 text-sm text-fg-muted">{k8sInitError.error}</p>
                      <p className="mt-1 text-xs text-fg-subtle">
                        Last attempt: {new Date(k8sInitError.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Auto-install CRDs Toggle */}
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-fg">Auto-install CRDs</p>
                  <p className="text-xs text-fg-muted">
                    Automatically install AgentPane CRDs and namespace when connecting to the
                    cluster
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoInstallCRDs}
                  onClick={() => setAutoInstallCRDs(!autoInstallCRDs)}
                  className={cn(
                    'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors',
                    autoInstallCRDs ? 'bg-accent' : 'bg-fg-muted/30'
                  )}
                  data-testid="k8s-auto-install-crds-toggle"
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform mt-0.5',
                      autoInstallCRDs ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </div>

              {/* Auto-start Minikube Toggle */}
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-fg">Auto-start Minikube</p>
                  <p className="text-xs text-fg-muted">
                    Automatically run &apos;minikube start&apos; if the cluster is unreachable and
                    context is minikube
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoStartMinikube}
                  onClick={() => setAutoStartMinikube(!autoStartMinikube)}
                  className={cn(
                    'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors',
                    autoStartMinikube ? 'bg-accent' : 'bg-fg-muted/30'
                  )}
                  data-testid="k8s-auto-start-minikube-toggle"
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform mt-0.5',
                      autoStartMinikube ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </div>

              {/* Fall back to Docker Toggle */}
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-fg">Fall back to Docker if unavailable</p>
                  <p className="text-xs text-fg-muted">
                    If the Kubernetes cluster is unreachable, fall back to Docker instead of
                    disabling container agents
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={fallbackToDocker}
                  onClick={() => setFallbackToDocker(!fallbackToDocker)}
                  className={cn(
                    'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors',
                    fallbackToDocker ? 'bg-accent' : 'bg-fg-muted/30'
                  )}
                  data-testid="k8s-fallback-to-docker-toggle"
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform mt-0.5',
                      fallbackToDocker ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
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
                  <Button
                    onClick={saveDefaultSettings}
                    disabled={isSavingDefaults}
                    className={cn(
                      'min-w-[140px] transition-all',
                      defaultsSaved && 'bg-success hover:bg-success'
                    )}
                    data-testid="save-k8s-settings"
                  >
                    {isSavingDefaults ? (
                      <>
                        <CircleNotch className="h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : defaultsSaved ? (
                      <>
                        <Check className="h-4 w-4" weight="bold" />
                        Saved!
                      </>
                    ) : (
                      'Save Settings'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </ConfigSection>
        )}

        {/* Resource Profiles Section */}
        <ConfigSection
          icon={Gauge}
          title="Resource Profiles"
          description="Define resource limits for agent sandboxes"
          badge={configs.length.toString()}
          badgeColor="accent"
          testId="profiles-section"
        >
          <div className="space-y-4">
            {/* Action bar */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-fg-muted">
                {configs.length} profile{configs.length !== 1 ? 's' : ''}
              </p>
              <Button data-testid="create-sandbox-config" onClick={openCreateEditor}>
                <Plus className="h-4 w-4" />
                New Profile
              </Button>
            </div>

            {/* Loading state */}
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <CircleNotch className="h-8 w-8 animate-spin text-fg-muted" />
              </div>
            )}

            {/* Empty state */}
            {!isLoading && configs.length === 0 && (
              <div className="rounded-lg border border-border bg-surface p-12 text-center">
                <Package className="mx-auto h-12 w-12 text-fg-subtle" />
                <h3 className="mt-4 text-lg font-medium text-fg">No resource profiles</h3>
                <p className="mt-2 text-sm text-fg-muted">
                  Create a profile to define resource limits for agent sandboxes.
                </p>
                <Button className="mt-6" onClick={openCreateEditor}>
                  <Plus className="h-4 w-4" />
                  Create Profile
                </Button>
              </div>
            )}

            {/* Config list - using modernized cards, sorted by memory low to high */}
            {!isLoading && configs.length > 0 && (
              <div className="space-y-3">
                {[...configs]
                  .sort((a, b) => a.memoryMb - b.memoryMb)
                  .map((config) => (
                    <div
                      key={config.id}
                      data-testid={`sandbox-config-${config.id}`}
                      className="rounded-lg border border-border/70 bg-surface-subtle/30 px-4 py-3 transition-all hover:border-border"
                    >
                      {/* Header row */}
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-fg">{config.name}</h3>
                        <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
                          {config.type === 'kubernetes'
                            ? '☸️ K8s'
                            : config.type === 'devcontainer'
                              ? '📦 DevContainer'
                              : '🐳 Docker'}
                        </span>
                        {config.isDefault && (
                          <span className="rounded bg-success-muted px-1.5 py-0.5 text-[11px] font-medium text-success">
                            Default
                          </span>
                        )}
                        {config.description && (
                          <span className="text-xs text-fg-subtle">{config.description}</span>
                        )}
                        <div className="ml-auto flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditEditor(config)}
                            data-testid={`edit-sandbox-config-${config.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(config)}
                            data-testid={`delete-sandbox-config-${config.id}`}
                          >
                            <Trash className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {/* Inline resource stats */}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          <span className="font-mono font-medium text-fg">{config.memoryMb}</span>{' '}
                          MB
                        </span>
                        <span className="flex items-center gap-1">
                          <Cpu className="h-3 w-3" />
                          <span className="font-mono font-medium text-fg">{config.cpuCores}</span>{' '}
                          cores
                        </span>
                        <span className="flex items-center gap-1">
                          <TreeStructure className="h-3 w-3" />
                          <span className="font-mono font-medium text-fg">
                            {config.maxProcesses}
                          </span>{' '}
                          PIDs
                        </span>
                        <span className="flex items-center gap-1">
                          <Timer className="h-3 w-3" />
                          <span className="font-mono font-medium text-fg">
                            {config.timeoutMinutes}
                          </span>{' '}
                          min
                        </span>
                        <span className="text-fg-subtle">|</span>
                        <span className="font-mono">{config.baseImage}</span>
                        {config.type === 'kubernetes' &&
                          (config as SandboxConfigItem).kubeNamespace && (
                            <>
                              <span className="text-fg-subtle">|</span>
                              <span className="flex items-center gap-1">
                                <Cloud className="h-3 w-3" />
                                ns:{' '}
                                <span className="font-mono">
                                  {(config as SandboxConfigItem).kubeNamespace}
                                </span>
                              </span>
                            </>
                          )}
                        {config.type !== 'kubernetes' && config.volumeMountPath && (
                          <>
                            <span className="text-fg-subtle">|</span>
                            <span className="flex items-center gap-1">
                              <FolderOpen className="h-3 w-3" />
                              <span className="font-mono">{config.volumeMountPath}</span>
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </ConfigSection>

        {/* Sticky Save Footer */}
        <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-border bg-surface/95 px-5 py-4 shadow-lg backdrop-blur-sm">
          <p className="text-sm text-fg-muted">Provider settings</p>
          <Button
            data-testid="save-provider-settings"
            onClick={handleSaveProvider}
            disabled={isSavingProvider}
            className={cn(
              'min-w-[140px] transition-all',
              providerSaved && 'bg-success-emphasis hover:bg-success-emphasis'
            )}
          >
            {isSavingProvider ? (
              <>
                <CircleNotch className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : providerSaved ? (
              <>
                <Check className="h-4 w-4" weight="bold" />
                Saved!
              </>
            ) : (
              'Save Provider'
            )}
          </Button>
        </div>
      </div>

      {/* Editor modal */}
      {editorMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl">
            {/* Modal header with gradient accent */}
            <div className="relative border-b border-border px-6 py-4">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-fg">
                  {editorMode === 'create' ? 'New Resource Profile' : 'Edit Profile'}
                </h2>
                <button
                  type="button"
                  onClick={closeEditor}
                  className="rounded-md p-1 text-fg-muted hover:bg-surface-subtle hover:text-fg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-6">
              <div className="space-y-5">
                {/* Basic Info Group */}
                <div className="space-y-4">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                    Basic Information
                  </h3>

                  {/* Name */}
                  <div>
                    <label
                      htmlFor="sandbox-name"
                      className="mb-1.5 block text-sm font-medium text-fg"
                    >
                      Name
                    </label>
                    <input
                      id="sandbox-name"
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g., High Performance"
                      className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                      data-testid="sandbox-config-name-input"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label
                      htmlFor="sandbox-description"
                      className="mb-1.5 block text-sm font-medium text-fg"
                    >
                      Description
                      <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
                    </label>
                    <textarea
                      id="sandbox-description"
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      placeholder="Configuration for compute-intensive tasks"
                      rows={2}
                      className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>
                </div>

                {/* Sandbox Type */}
                <div className="space-y-3">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                    Sandbox Type
                  </h3>
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => setFormType('docker')}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all',
                        formType === 'docker'
                          ? 'border-accent bg-accent-muted/30'
                          : 'border-border hover:border-fg-subtle'
                      )}
                      data-testid="sandbox-type-docker"
                    >
                      <span className="text-xl">🐳</span>
                      <div>
                        <div className="text-sm font-medium text-fg">Docker</div>
                        <div className="text-xs text-fg-muted">Container</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormType('devcontainer')}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all',
                        formType === 'devcontainer'
                          ? 'border-accent bg-accent-muted/30'
                          : 'border-border hover:border-fg-subtle'
                      )}
                      data-testid="sandbox-type-devcontainer"
                    >
                      <span className="text-xl">📦</span>
                      <div>
                        <div className="text-sm font-medium text-fg">DevContainer</div>
                        <div className="text-xs text-fg-muted">VS Code</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormType('kubernetes')}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all',
                        formType === 'kubernetes'
                          ? 'border-accent bg-accent-muted/30'
                          : 'border-border hover:border-fg-subtle'
                      )}
                      data-testid="sandbox-type-kubernetes"
                    >
                      <span className="text-xl">☸️</span>
                      <div>
                        <div className="text-sm font-medium text-fg">K8s</div>
                        <div className="text-xs text-fg-muted">Kubernetes</div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Container Configuration Group */}
                <div className="space-y-4">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                    Container Configuration
                  </h3>

                  {/* Base Image */}
                  <div>
                    <label
                      htmlFor="sandbox-image"
                      className="mb-1.5 block text-sm font-medium text-fg"
                    >
                      Base Image
                    </label>
                    <input
                      id="sandbox-image"
                      type="text"
                      value={formBaseImage}
                      onChange={(e) => setFormBaseImage(e.target.value)}
                      placeholder="node:22-slim"
                      className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                      data-testid="sandbox-config-image-input"
                    />
                  </div>

                  {/* Volume Mount Path - Docker only */}
                  {formType === 'docker' && (
                    <div>
                      <label
                        htmlFor="sandbox-volume-mount"
                        className="mb-1.5 block text-sm font-medium text-fg"
                      >
                        Volume Mount Path
                        <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <FolderOpen className="h-4 w-4 text-fg-muted" />
                        <input
                          id="sandbox-volume-mount"
                          type="text"
                          value={formVolumeMountPath}
                          onChange={(e) => setFormVolumeMountPath(e.target.value)}
                          placeholder="/home/user/projects"
                          className="flex-1 rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                          data-testid="sandbox-config-volume-mount-input"
                        />
                      </div>
                      <p className="mt-1 text-xs text-fg-muted">
                        Local host directory to mount into the container
                      </p>
                    </div>
                  )}

                  {/* Kubernetes Configuration - K8s only */}
                  {formType === 'kubernetes' && (
                    <div className="space-y-4 rounded-lg border border-border bg-surface-subtle p-4">
                      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
                        ☸️ Kubernetes Settings
                      </h4>

                      {/* Kubeconfig Path */}
                      <div>
                        <label
                          htmlFor="form-kube-config-path"
                          className="mb-1.5 block text-sm font-medium text-fg"
                        >
                          Kubeconfig Path
                          <span className="ml-1 text-xs font-normal text-fg-subtle">
                            (optional)
                          </span>
                        </label>
                        <input
                          id="form-kube-config-path"
                          type="text"
                          value={formKubeConfigPath}
                          onChange={(e) => setFormKubeConfigPath(e.target.value)}
                          placeholder="~/.kube/config"
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                          data-testid="form-kube-config-path-input"
                        />
                      </div>

                      {/* Context */}
                      <div>
                        <label
                          htmlFor="form-kube-context"
                          className="mb-1.5 block text-sm font-medium text-fg"
                        >
                          Context
                          <span className="ml-1 text-xs font-normal text-fg-subtle">
                            (optional)
                          </span>
                        </label>
                        <input
                          id="form-kube-context"
                          type="text"
                          value={formKubeContext}
                          onChange={(e) => setFormKubeContext(e.target.value)}
                          placeholder="minikube"
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                          data-testid="form-kube-context-input"
                        />
                      </div>

                      {/* Namespace */}
                      <div>
                        <label
                          htmlFor="form-kube-namespace"
                          className="mb-1.5 block text-sm font-medium text-fg"
                        >
                          Namespace
                        </label>
                        <input
                          id="form-kube-namespace"
                          type="text"
                          value={formKubeNamespace}
                          onChange={(e) => setFormKubeNamespace(e.target.value)}
                          placeholder="agentpane-sandboxes"
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                          data-testid="form-kube-namespace-input"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Resource Limits Group */}
                <div className="space-y-4">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                    Resource Limits
                  </h3>

                  {/* Memory */}
                  <div>
                    <label
                      htmlFor="sandbox-memory"
                      className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
                    >
                      <span>Memory</span>
                      <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
                        {formMemoryMb} MB
                      </span>
                    </label>
                    <input
                      id="sandbox-memory"
                      type="range"
                      min={512}
                      max={16384}
                      step={512}
                      value={formMemoryMb}
                      onChange={(e) => setFormMemoryMb(Number(e.target.value))}
                      className="w-full accent-accent"
                      data-testid="sandbox-config-memory-slider"
                    />
                    <div className="mt-1 flex justify-between text-xs text-fg-subtle">
                      <span>512 MB</span>
                      <span>16 GB</span>
                    </div>
                  </div>

                  {/* CPU */}
                  <div>
                    <label
                      htmlFor="sandbox-cpu"
                      className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
                    >
                      <span>CPU Cores</span>
                      <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
                        {formCpuCores} cores
                      </span>
                    </label>
                    <input
                      id="sandbox-cpu"
                      type="range"
                      min={0.5}
                      max={8}
                      step={0.5}
                      value={formCpuCores}
                      onChange={(e) => setFormCpuCores(Number(e.target.value))}
                      className="w-full accent-accent"
                      data-testid="sandbox-config-cpu-slider"
                    />
                    <div className="mt-1 flex justify-between text-xs text-fg-subtle">
                      <span>0.5</span>
                      <span>8</span>
                    </div>
                  </div>

                  {/* Max Processes */}
                  <div>
                    <label
                      htmlFor="sandbox-processes"
                      className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
                    >
                      <span>Max Processes (PIDs)</span>
                      <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
                        {formMaxProcesses}
                      </span>
                    </label>
                    <input
                      id="sandbox-processes"
                      type="range"
                      min={32}
                      max={1024}
                      step={32}
                      value={formMaxProcesses}
                      onChange={(e) => setFormMaxProcesses(Number(e.target.value))}
                      className="w-full accent-accent"
                      data-testid="sandbox-config-processes-slider"
                    />
                    <div className="mt-1 flex justify-between text-xs text-fg-subtle">
                      <span>32</span>
                      <span>1024</span>
                    </div>
                  </div>

                  {/* Timeout */}
                  <div>
                    <label
                      htmlFor="sandbox-timeout"
                      className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
                    >
                      <span>Timeout</span>
                      <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
                        {formTimeoutMinutes} min
                      </span>
                    </label>
                    <input
                      id="sandbox-timeout"
                      type="range"
                      min={5}
                      max={1440}
                      step={5}
                      value={formTimeoutMinutes}
                      onChange={(e) => setFormTimeoutMinutes(Number(e.target.value))}
                      className="w-full accent-accent"
                      data-testid="sandbox-config-timeout-slider"
                    />
                    <div className="mt-1 flex justify-between text-xs text-fg-subtle">
                      <span>5 min</span>
                      <span>24 hrs</span>
                    </div>
                  </div>
                </div>

                {/* Default toggle */}
                <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-fg">Set as default</p>
                    <p className="text-xs text-fg-muted">
                      Used when no specific configuration is selected
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={formIsDefault}
                    onClick={() => setFormIsDefault(!formIsDefault)}
                    className={cn(
                      'relative h-6 w-11 rounded-full transition-colors',
                      formIsDefault ? 'bg-accent' : 'bg-surface-muted'
                    )}
                    data-testid="sandbox-config-default-toggle"
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
                        formIsDefault ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
                </div>

                {/* Error display */}
                {saveError && (
                  <div className="rounded-md border border-danger/30 bg-danger-muted/30 p-3">
                    <p className="flex items-center gap-2 text-sm text-danger">
                      <Warning className="h-4 w-4" />
                      {saveError}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
              <Button variant="outline" onClick={closeEditor}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving} data-testid="save-sandbox-config">
                {isSaving ? (
                  <>
                    <CircleNotch className="h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    {editorMode === 'create' ? 'Create' : 'Save Changes'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
