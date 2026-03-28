import {
  CircleNotch,
  Cloud,
  Cpu,
  Cube,
  HardDrive,
  Hexagon,
  Sliders,
  Timer,
} from '@phosphor-icons/react';
import { ConfigSection } from '@/app/components/ui/config-section';
import type { SandboxProvider } from '@/lib/sandbox/types';
import { cn } from '@/lib/utils/cn';
import { type DefaultSandboxSettings, SaveButton, Toggle } from './shared.js';

export interface DefaultSettingsSectionProps {
  defaultSettings: DefaultSandboxSettings;
  setDefaultSettings: React.Dispatch<React.SetStateAction<DefaultSandboxSettings>>;
  setSelectedProvider: (provider: SandboxProvider) => void;
  isLoadingDefaults: boolean;
  isSavingDefaults: boolean;
  defaultsSaved: boolean;
  saveDefaultSettings: () => void;
}

export function DefaultSettingsSection({
  defaultSettings,
  setDefaultSettings,
  setSelectedProvider,
  isLoadingDefaults,
  isSavingDefaults,
  defaultsSaved,
  saveDefaultSettings,
}: DefaultSettingsSectionProps): React.JSX.Element {
  return (
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
                <Cube className="h-5 w-5" weight={defaultSettings.enabled ? 'fill' : 'regular'} />
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
            <Toggle
              checked={defaultSettings.enabled}
              onToggle={() => setDefaultSettings((prev) => ({ ...prev, enabled: !prev.enabled }))}
              testId="default-sandbox-enabled-toggle"
              ariaLabel="Enable Sandbox by Default"
            />
          </div>

          {/* Provider selection */}
          <div
            className={cn(
              'transition-opacity',
              defaultSettings.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            )}
          >
            <p className="mb-3 text-sm font-medium text-fg">Default Provider</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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

              {/* Nomad */}
              <button
                type="button"
                onClick={() => {
                  setDefaultSettings((prev) => ({ ...prev, provider: 'nomad' }));
                  setSelectedProvider('nomad');
                }}
                className={cn(
                  'relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all',
                  defaultSettings.provider === 'nomad'
                    ? 'border-attention bg-attention/10'
                    : 'border-border hover:border-fg-subtle'
                )}
                data-testid="default-provider-nomad"
              >
                <Hexagon
                  className={cn(
                    'h-6 w-6',
                    defaultSettings.provider === 'nomad' ? 'text-attention' : 'text-fg-muted'
                  )}
                  weight={defaultSettings.provider === 'nomad' ? 'duotone' : 'regular'}
                />
                <span
                  className={cn(
                    'text-sm font-medium',
                    defaultSettings.provider === 'nomad' ? 'text-attention' : 'text-fg'
                  )}
                >
                  Nomad
                </span>
                <span className="text-xs text-fg-muted">Scheduled jobs</span>
                {defaultSettings.provider === 'nomad' && (
                  <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-attention" />
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
                        defaultSettings.containerMode === 'per-project' ? 'text-accent' : 'text-fg'
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
            <SaveButton
              saving={isSavingDefaults}
              saved={defaultsSaved}
              onClick={saveDefaultSettings}
              testId="save-default-settings"
            />
          </div>
        </div>
      )}
    </ConfigSection>
  );
}
