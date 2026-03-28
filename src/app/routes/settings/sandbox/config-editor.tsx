import { Check, CircleNotch, FolderOpen, Hexagon, Warning, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  apiClient,
  type CreateSandboxConfigInput,
  type SandboxConfigItem,
  type UpdateSandboxConfigInput,
} from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { type EditorMode, Toggle } from './shared.js';

export interface ConfigEditorProps {
  editorMode: EditorMode;
  editingConfig: SandboxConfigItem | null;
  closeEditor: () => void;
  loadConfigs: () => Promise<void>;
}

export function ConfigEditor({
  editorMode,
  editingConfig,
  closeEditor,
  loadConfigs,
}: ConfigEditorProps): React.JSX.Element | null {
  if (!editorMode) return null;

  return (
    <ConfigEditorInner
      editorMode={editorMode}
      editingConfig={editingConfig}
      closeEditor={closeEditor}
      loadConfigs={loadConfigs}
    />
  );
}

/** Inner component that only mounts when the editor is open, so hooks are stable. */
function ConfigEditorInner({
  editorMode,
  editingConfig,
  closeEditor,
  loadConfigs,
}: {
  editorMode: 'create' | 'edit';
  editingConfig: SandboxConfigItem | null;
  closeEditor: () => void;
  loadConfigs: () => Promise<void>;
}): React.JSX.Element {
  // Form state — initialized from editingConfig when in edit mode
  const [formName, setFormName] = useState(editingConfig?.name ?? '');
  const [formDescription, setFormDescription] = useState(editingConfig?.description ?? '');
  const [formType, setFormType] = useState<'docker' | 'devcontainer' | 'kubernetes' | 'nomad'>(
    (editingConfig?.type as 'docker' | 'devcontainer' | 'kubernetes' | 'nomad') ?? 'docker'
  );
  const [formBaseImage, setFormBaseImage] = useState(editingConfig?.baseImage ?? 'node:22-slim');
  const [formMemoryMb, setFormMemoryMb] = useState(editingConfig?.memoryMb ?? 4096);
  const [formCpuCores, setFormCpuCores] = useState(editingConfig?.cpuCores ?? 2.0);
  const [formMaxProcesses, setFormMaxProcesses] = useState(editingConfig?.maxProcesses ?? 256);
  const [formTimeoutMinutes, setFormTimeoutMinutes] = useState(editingConfig?.timeoutMinutes ?? 60);
  const [formIsDefault, setFormIsDefault] = useState(editingConfig?.isDefault ?? false);
  const [formVolumeMountPath, setFormVolumeMountPath] = useState(
    editingConfig?.volumeMountPath ?? ''
  );
  // K8s form state
  const [formKubeConfigPath, setFormKubeConfigPath] = useState(editingConfig?.kubeConfigPath ?? '');
  const [formKubeContext, setFormKubeContext] = useState(editingConfig?.kubeContext ?? '');
  const [formKubeNamespace, setFormKubeNamespace] = useState(
    editingConfig?.kubeNamespace ?? 'agentpane-sandboxes'
  );
  // Nomad form state (setters unused — values are only read for handleSave)
  const [formNomadAddress] = useState(editingConfig?.nomadAddress ?? '');
  const [formNomadToken] = useState('');
  const [formNomadNamespace] = useState(editingConfig?.nomadNamespace ?? 'default');
  const [formNomadDatacenter] = useState(editingConfig?.nomadDatacenter ?? '');
  const [formNomadRegion] = useState(editingConfig?.nomadRegion ?? '');

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!formName.trim()) {
      setSaveError('Name is required');
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    const input: CreateSandboxConfigInput & UpdateSandboxConfigInput = {
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
      kubeConfigPath: formKubeConfigPath || undefined,
      kubeContext: formKubeContext || undefined,
      kubeNamespace: formKubeNamespace || undefined,
      nomadAddress: formNomadAddress || undefined,
      nomadToken: formNomadToken || undefined,
      nomadNamespace: formNomadNamespace || undefined,
      nomadDatacenter: formNomadDatacenter || undefined,
      nomadRegion: formNomadRegion || undefined,
    };

    try {
      if (editorMode === 'create') {
        const result = await apiClient.sandboxConfigs.create(input);
        if (!result.ok) {
          setSaveError(result.error.message);
          return;
        }
      } else if (editorMode === 'edit' && editingConfig) {
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

  return (
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
                <label htmlFor="sandbox-name" className="mb-1.5 block text-sm font-medium text-fg">
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
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                <button
                  type="button"
                  onClick={() => setFormType('nomad')}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all',
                    formType === 'nomad'
                      ? 'border-attention bg-attention/10'
                      : 'border-border hover:border-fg-subtle'
                  )}
                  data-testid="sandbox-type-nomad"
                >
                  <Hexagon
                    className={cn(
                      'h-5 w-5',
                      formType === 'nomad' ? 'text-attention' : 'text-fg-muted'
                    )}
                    weight={formType === 'nomad' ? 'duotone' : 'regular'}
                  />
                  <div>
                    <div className="text-sm font-medium text-fg">Nomad</div>
                    <div className="text-xs text-fg-muted">Scheduled</div>
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
                <label htmlFor="sandbox-image" className="mb-1.5 block text-sm font-medium text-fg">
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
                      <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
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
                      <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
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
              <Toggle
                checked={formIsDefault}
                onToggle={() => setFormIsDefault(!formIsDefault)}
                testId="sandbox-config-default-toggle"
                ariaLabel="Set as default"
              />
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
  );
}
