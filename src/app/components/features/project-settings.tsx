import {
  ArrowSquareOut,
  Brain,
  Cloud,
  Cpu,
  Cube,
  Database,
  Eye,
  EyeSlash,
  FolderSimple,
  Gear,
  GitBranch,
  HardDrives,
  Hexagon,
  Key,
  Lightning,
  Package,
  Plus,
  Timer,
  Trash,
} from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { Switch } from '@/app/components/ui/switch';
import { TextInput } from '@/app/components/ui/text-input';
import { Textarea } from '@/app/components/ui/textarea';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { useFolderData } from '@/app/providers/folder-context';
import type { Codespace, CodespaceConfig } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import { AVAILABLE_MODELS } from '@/lib/constants/models';
import type { CodespaceSandboxConfig } from '@/lib/sandbox/types';
import { cn } from '@/lib/utils/cn';
import { DeleteProjectDialog } from './delete-project-dialog';

interface ProjectSettingsProps {
  project: Codespace;
  onSave: (input: {
    name?: string;
    description?: string;
    maxConcurrentAgents?: number;
    config?: Partial<CodespaceConfig>;
    projectFolderId?: string;
    githubOwner?: string;
    githubRepo?: string;
  }) => Promise<void>;
  onDelete: (options: { deleteFiles: boolean }) => Promise<void>;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

// Section header component for consistent styling
function SectionHeader({
  icon: Icon,
  title,
  description,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20">
        <Icon className="h-6 w-6 text-accent" weight="duotone" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-fg tracking-tight">{title}</h2>
          {badge}
        </div>
        <p className="text-sm text-fg-muted mt-0.5">{description}</p>
      </div>
    </div>
  );
}

// Status badge component
function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium',
        enabled
          ? 'bg-success/15 text-success border border-success/20'
          : 'bg-fg-muted/10 text-fg-muted border border-border'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          enabled ? 'bg-success animate-pulse' : 'bg-fg-muted'
        )}
      />
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

// Field label component
function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-2">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {children}
      </label>
      {hint && <span className="text-xs text-fg-muted">{hint}</span>}
    </div>
  );
}

// Card wrapper for sections
function SettingsCard({
  children,
  className,
  highlight,
}: {
  children: React.ReactNode;
  className?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface p-6 transition-all duration-normal',
        highlight
          ? 'border-accent/30 bg-gradient-to-br from-accent/5 to-transparent shadow-lg shadow-accent/5'
          : 'border-border',
        className
      )}
    >
      {children}
    </div>
  );
}

export function ProjectSettings({
  project,
  onSave,
  onDelete,
  saveStatus = 'idle',
}: ProjectSettingsProps): React.JSX.Element {
  const { folders } = useFolderData();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [projectFolderId, setProjectFolderId] = useState(project.projectFolderId ?? '');
  const [maxConcurrent, setMaxConcurrent] = useState(project.maxConcurrentAgents ?? 3);
  const [githubOwner, setGithubOwner] = useState(project.githubOwner ?? '');
  const [githubRepo, setGithubRepo] = useState(project.githubRepo ?? '');
  const [config, setConfig] = useState<CodespaceConfig>(
    project.config ?? {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    }
  );

  // Global sandbox defaults (loaded from settings)
  const [globalDefaults, setGlobalDefaults] = useState<CodespaceSandboxConfig | null>(null);
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(true);

  // Load global defaults and sandbox env vars on mount
  useMountEffect(() => {
    const loadDefaults = async () => {
      try {
        const result = await apiClient.settings.get(['sandbox.defaults', 'sandbox.env']);
        if (result.ok && result.data.settings['sandbox.defaults']) {
          setGlobalDefaults(result.data.settings['sandbox.defaults'] as CodespaceSandboxConfig);
        }
        if (result.ok && result.data.settings['sandbox.env']) {
          const envObj = result.data.settings['sandbox.env'] as Record<string, string>;
          setSandboxEnvVars(Object.entries(envObj).map(([key, value]) => ({ key, value })));
        }
      } catch (error) {
        console.error('[ProjectSettings] Failed to load global defaults:', error);
      } finally {
        setIsLoadingDefaults(false);
        setSandboxEnvLoading(false);
      }
    };
    void loadDefaults();
  });

  // Sandbox configuration - uses existing project config or falls back to global defaults
  const existingSandbox = project.config?.sandbox as CodespaceSandboxConfig | undefined | null;
  // Track if project has explicit custom sandbox config (not null)
  const [hasCustomConfig, setHasCustomConfig] = useState(
    existingSandbox !== undefined && existingSandbox !== null
  );
  const [sandboxConfig, setSandboxConfig] = useState<CodespaceSandboxConfig>({
    enabled: existingSandbox?.enabled ?? globalDefaults?.enabled ?? false,
    provider: existingSandbox?.provider ?? globalDefaults?.provider ?? 'docker',
    idleTimeoutMinutes:
      existingSandbox?.idleTimeoutMinutes ?? globalDefaults?.idleTimeoutMinutes ?? 30,
    memoryMb: existingSandbox?.memoryMb ?? globalDefaults?.memoryMb ?? 2048,
    cpuCores: existingSandbox?.cpuCores ?? globalDefaults?.cpuCores ?? 2,
    image: existingSandbox?.image ?? globalDefaults?.image ?? '',
    namespace: existingSandbox?.namespace ?? globalDefaults?.namespace ?? 'default',
    serviceAccount: existingSandbox?.serviceAccount ?? '',
    nomadNamespace: existingSandbox?.nomadNamespace ?? globalDefaults?.nomadNamespace ?? 'default',
  });
  // Track if user has made any changes to sandbox settings
  const [sandboxModified, setSandboxModified] = useState(false);

  // Wrapper to track sandbox modifications
  const updateSandboxConfig = (
    updater: (prev: CodespaceSandboxConfig) => CodespaceSandboxConfig
  ) => {
    setSandboxConfig(updater);
    setSandboxModified(true);
    setHasCustomConfig(true);
  };

  // Reset to global defaults
  const resetToGlobalDefaults = () => {
    if (globalDefaults) {
      setSandboxConfig({
        enabled: globalDefaults.enabled ?? false,
        provider: globalDefaults.provider ?? 'docker',
        idleTimeoutMinutes: globalDefaults.idleTimeoutMinutes ?? 30,
        memoryMb: globalDefaults.memoryMb ?? 2048,
        cpuCores: globalDefaults.cpuCores ?? 2,
        image: globalDefaults.image ?? '',
        namespace: globalDefaults.namespace ?? 'default',
        serviceAccount: '',
        nomadNamespace: globalDefaults.nomadNamespace ?? 'default',
      });
    }
    setHasCustomConfig(false);
    setSandboxModified(true);
  };

  // Update sandbox config when global defaults load (only if no custom config)
  useWatchEffect(() => {
    if (!hasCustomConfig && globalDefaults && !isLoadingDefaults) {
      setSandboxConfig((prev) => ({
        ...prev,
        enabled: globalDefaults.enabled ?? prev.enabled,
        provider: globalDefaults.provider ?? prev.provider,
        idleTimeoutMinutes: globalDefaults.idleTimeoutMinutes ?? prev.idleTimeoutMinutes,
        memoryMb: globalDefaults.memoryMb ?? prev.memoryMb,
        cpuCores: globalDefaults.cpuCores ?? prev.cpuCores,
      }));
    }
  }, [globalDefaults, hasCustomConfig, isLoadingDefaults]);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    Object.entries(project.config?.envVars ?? {}).map(([key, value]) => ({ key, value }))
  );
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');

  // Sandbox environment variables (stored in global settings as sandbox.env)
  const [sandboxEnvVars, setSandboxEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [sandboxEnvLoading, setSandboxEnvLoading] = useState(true);
  const [sandboxEnvSaving, setSandboxEnvSaving] = useState(false);
  const [sandboxEnvSaveStatus, setSandboxEnvSaveStatus] = useState<'idle' | 'saved' | 'error'>(
    'idle'
  );
  const [newSandboxEnvKey, setNewSandboxEnvKey] = useState('');
  const [newSandboxEnvValue, setNewSandboxEnvValue] = useState('');
  const [sandboxEnvVisibility, setSandboxEnvVisibility] = useState<Record<number, boolean>>({});
  const [sandboxEnvErrorMsg, setSandboxEnvErrorMsg] = useState<string | null>(null);

  const handleSaveSandboxEnv = async () => {
    setSandboxEnvSaving(true);
    setSandboxEnvSaveStatus('idle');
    setSandboxEnvErrorMsg(null);
    try {
      const envObj: Record<string, string> = {};
      for (const { key, value } of sandboxEnvVars) {
        const trimmed = key.trim();
        if (trimmed) {
          envObj[trimmed] = value;
        }
      }
      const result = await apiClient.settings.update({ 'sandbox.env': envObj });
      if (result.ok) {
        setSandboxEnvSaveStatus('saved');
        setTimeout(() => setSandboxEnvSaveStatus('idle'), 2000);
      } else {
        const msg = (result.error as { message?: string })?.message ?? 'Server returned an error';
        console.error('[ProjectSettings] Failed to save sandbox env vars:', msg);
        setSandboxEnvSaveStatus('error');
        setSandboxEnvErrorMsg(msg);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ProjectSettings] Failed to save sandbox env vars:', error);
      setSandboxEnvSaveStatus('error');
      setSandboxEnvErrorMsg(msg);
    } finally {
      setSandboxEnvSaving(false);
    }
  };

  const handleSave = () => {
    const envVarsObject = envVars.reduce(
      (acc, { key, value }) => {
        if (key.trim()) {
          acc[key.trim()] = value;
        }
        return acc;
      },
      {} as Record<string, string>
    );

    // Only include sandbox in config if:
    // 1. User has made changes (sandboxModified)
    // 2. AND hasCustomConfig is true (user wants explicit config)
    // If hasCustomConfig is false but sandboxModified is true, we need to set sandbox: null
    const sandboxToSave = sandboxModified
      ? hasCustomConfig
        ? sandboxConfig
        : null // Explicitly remove custom config to use global defaults
      : undefined; // Don't touch sandbox config

    void onSave({
      name,
      description,
      maxConcurrentAgents: maxConcurrent,
      projectFolderId,
      githubOwner: githubOwner || undefined,
      githubRepo: githubRepo || undefined,
      config: {
        ...config,
        ...(sandboxToSave !== undefined && { sandbox: sandboxToSave }),
        envVars: Object.keys(envVarsObject).length > 0 ? envVarsObject : undefined,
      },
    });
  };

  return (
    <div className="space-y-6" data-testid="project-settings">
      {/* GitHub Repository */}
      <SettingsCard>
        <SectionHeader
          icon={GitBranch}
          title="GitHub Repository"
          description="Configure the GitHub repository for git isolation and PR creation during agent execution."
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="github-owner" className="block text-sm font-medium text-fg mb-1.5">
              Owner
            </label>
            <TextInput
              id="github-owner"
              value={githubOwner}
              onChange={(e) => setGithubOwner(e.target.value)}
              placeholder="e.g. my-org"
              data-testid="github-owner-input"
            />
          </div>
          <div>
            <label htmlFor="github-repo" className="block text-sm font-medium text-fg mb-1.5">
              Repository
            </label>
            <TextInput
              id="github-repo"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="e.g. my-repo"
              data-testid="github-repo-input"
            />
          </div>
        </div>
        {!githubOwner && !githubRepo && (
          <p className="mt-3 text-xs text-fg-muted">
            Without a GitHub repository, agents will work without git isolation — changes cannot be
            pushed or PR'd.
          </p>
        )}
      </SettingsCard>

      {/* Sandbox Configuration - Featured prominently */}
      <SettingsCard highlight={sandboxConfig.enabled}>
        <SectionHeader
          icon={Cube}
          title="Sandbox Execution"
          description="Run agents in isolated containers for enhanced security and reproducibility."
          badge={<StatusBadge enabled={sandboxConfig.enabled} />}
        />

        {/* Global defaults indicator */}
        {!isLoadingDefaults && globalDefaults && !hasCustomConfig && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-fg-muted">Using</span>
              <Link
                to="/settings/sandbox"
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                global defaults
                <ArrowSquareOut className="h-3.5 w-3.5" />
              </Link>
            </div>
            <span className="text-xs text-fg-muted">Changes here override global settings</span>
          </div>
        )}

        {/* Custom config indicator with reset option */}
        {!isLoadingDefaults && globalDefaults && hasCustomConfig && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-fg-muted">Using</span>
              <span className="font-medium text-warning">custom codespace settings</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetToGlobalDefaults}
              className="text-xs text-accent hover:text-accent hover:bg-accent/10"
            >
              Reset to global defaults
            </Button>
          </div>
        )}

        {/* Enable toggle */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface-subtle border border-border mb-6">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                sandboxConfig.enabled
                  ? 'bg-success/20 text-success'
                  : 'bg-surface-muted text-fg-muted'
              )}
            >
              <Lightning className="h-5 w-5" weight={sandboxConfig.enabled ? 'fill' : 'regular'} />
            </div>
            <div>
              <p className="font-medium text-fg">Enable Container Sandbox</p>
              <p className="text-sm text-fg-muted">
                {sandboxConfig.enabled
                  ? `Agents execute in ${sandboxConfig.provider === 'kubernetes' ? 'Kubernetes pods' : sandboxConfig.provider === 'nomad' ? 'Nomad jobs' : sandboxConfig.provider === 'devcontainer' ? 'DevContainers' : 'Docker containers'}`
                  : 'Enable to run agents in isolated environments'}
              </p>
            </div>
          </div>
          <Switch
            checked={sandboxConfig.enabled}
            onCheckedChange={(checked: boolean) =>
              updateSandboxConfig((prev) => ({ ...prev, enabled: checked }))
            }
            data-testid="sandbox-enabled-toggle"
          />
        </div>

        {/* Provider selection - shown when enabled */}
        <div
          className={cn(
            'mb-6 transition-all duration-normal',
            sandboxConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
          )}
        >
          <p className="text-sm font-medium text-fg mb-3">Sandbox Provider</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* Docker */}
            <button
              type="button"
              onClick={() => updateSandboxConfig((prev) => ({ ...prev, provider: 'docker' }))}
              className={cn(
                'relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-fast',
                'hover:border-accent/50 hover:bg-accent/5',
                sandboxConfig.provider === 'docker'
                  ? 'border-accent bg-accent/10 shadow-sm'
                  : 'border-border bg-surface-subtle'
              )}
              data-testid="provider-docker"
            >
              <Cube
                className={cn(
                  'h-8 w-8 transition-colors',
                  sandboxConfig.provider === 'docker' ? 'text-accent' : 'text-fg-muted'
                )}
                weight={sandboxConfig.provider === 'docker' ? 'duotone' : 'regular'}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  sandboxConfig.provider === 'docker' ? 'text-accent' : 'text-fg'
                )}
              >
                Docker
              </span>
              <span className="text-xs text-fg-muted text-center">Local containers</span>
              {sandboxConfig.provider === 'docker' && (
                <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-accent" />
              )}
            </button>

            {/* DevContainer */}
            <button
              type="button"
              onClick={() => updateSandboxConfig((prev) => ({ ...prev, provider: 'devcontainer' }))}
              className={cn(
                'relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-fast',
                'hover:border-accent/50 hover:bg-accent/5',
                sandboxConfig.provider === 'devcontainer'
                  ? 'border-accent bg-accent/10 shadow-sm'
                  : 'border-border bg-surface-subtle'
              )}
              data-testid="provider-devcontainer"
            >
              <Package
                className={cn(
                  'h-8 w-8 transition-colors',
                  sandboxConfig.provider === 'devcontainer' ? 'text-accent' : 'text-fg-muted'
                )}
                weight={sandboxConfig.provider === 'devcontainer' ? 'duotone' : 'regular'}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  sandboxConfig.provider === 'devcontainer' ? 'text-accent' : 'text-fg'
                )}
              >
                DevContainer
              </span>
              <span className="text-xs text-fg-muted text-center">VS Code compatible</span>
              {sandboxConfig.provider === 'devcontainer' && (
                <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-accent" />
              )}
            </button>

            {/* Kubernetes */}
            <button
              type="button"
              onClick={() => updateSandboxConfig((prev) => ({ ...prev, provider: 'kubernetes' }))}
              className={cn(
                'relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-fast',
                'hover:border-accent/50 hover:bg-accent/5',
                sandboxConfig.provider === 'kubernetes'
                  ? 'border-accent bg-accent/10 shadow-sm'
                  : 'border-border bg-surface-subtle'
              )}
              data-testid="provider-kubernetes"
            >
              <Cloud
                className={cn(
                  'h-8 w-8 transition-colors',
                  sandboxConfig.provider === 'kubernetes' ? 'text-accent' : 'text-fg-muted'
                )}
                weight={sandboxConfig.provider === 'kubernetes' ? 'duotone' : 'regular'}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  sandboxConfig.provider === 'kubernetes' ? 'text-accent' : 'text-fg'
                )}
              >
                Kubernetes
              </span>
              <span className="text-xs text-fg-muted text-center">Cluster pods</span>
              {sandboxConfig.provider === 'kubernetes' && (
                <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-accent" />
              )}
            </button>

            {/* Nomad */}
            <button
              type="button"
              onClick={() => updateSandboxConfig((prev) => ({ ...prev, provider: 'nomad' }))}
              className={cn(
                'relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-fast',
                'hover:border-attention/50 hover:bg-attention/5',
                sandboxConfig.provider === 'nomad'
                  ? 'border-attention bg-attention/10 shadow-sm'
                  : 'border-border bg-surface-subtle'
              )}
              data-testid="provider-nomad"
            >
              <Hexagon
                className={cn(
                  'h-8 w-8 transition-colors',
                  sandboxConfig.provider === 'nomad' ? 'text-attention' : 'text-fg-muted'
                )}
                weight={sandboxConfig.provider === 'nomad' ? 'duotone' : 'regular'}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  sandboxConfig.provider === 'nomad' ? 'text-attention' : 'text-fg'
                )}
              >
                Nomad
              </span>
              <span className="text-xs text-fg-muted text-center">Scheduled jobs</span>
              {sandboxConfig.provider === 'nomad' && (
                <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-attention" />
              )}
            </button>
          </div>
        </div>

        {/* Sandbox options - shown when enabled */}
        <div
          className={cn(
            'grid gap-5 lg:grid-cols-2 transition-all duration-normal',
            sandboxConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
          )}
        >
          <div>
            <FieldLabel htmlFor="sandbox-memory" hint="MB">
              <HardDrives className="inline h-4 w-4 mr-1.5 text-fg-muted" weight="duotone" />
              Memory Limit
            </FieldLabel>
            <Select
              value={String(sandboxConfig.memoryMb)}
              onValueChange={(value) =>
                updateSandboxConfig((prev) => ({ ...prev, memoryMb: Number(value) }))
              }
              disabled={!sandboxConfig.enabled}
            >
              <SelectTrigger id="sandbox-memory" data-testid="sandbox-memory-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1024">1 GB</SelectItem>
                <SelectItem value="2048">2 GB</SelectItem>
                <SelectItem value="4096">4 GB</SelectItem>
                <SelectItem value="8192">8 GB</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="sandbox-cpu" hint="cores">
              <Cpu className="inline h-4 w-4 mr-1.5 text-fg-muted" weight="duotone" />
              CPU Cores
            </FieldLabel>
            <Select
              value={String(sandboxConfig.cpuCores)}
              onValueChange={(value) =>
                updateSandboxConfig((prev) => ({ ...prev, cpuCores: Number(value) }))
              }
              disabled={!sandboxConfig.enabled}
            >
              <SelectTrigger id="sandbox-cpu" data-testid="sandbox-cpu-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 core</SelectItem>
                <SelectItem value="2">2 cores</SelectItem>
                <SelectItem value="4">4 cores</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="sandbox-timeout" hint="minutes">
              <Timer className="inline h-4 w-4 mr-1.5 text-fg-muted" weight="duotone" />
              Idle Timeout
            </FieldLabel>
            <Select
              value={String(sandboxConfig.idleTimeoutMinutes)}
              onValueChange={(value) =>
                updateSandboxConfig((prev) => ({ ...prev, idleTimeoutMinutes: Number(value) }))
              }
              disabled={!sandboxConfig.enabled}
            >
              <SelectTrigger id="sandbox-timeout" data-testid="sandbox-timeout-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="120">2 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="sandbox-image" hint="optional">
              <Database className="inline h-4 w-4 mr-1.5 text-fg-muted" weight="duotone" />
              Custom Image
            </FieldLabel>
            <TextInput
              id="sandbox-image"
              value={sandboxConfig.image ?? ''}
              onChange={(e) => updateSandboxConfig((prev) => ({ ...prev, image: e.target.value }))}
              placeholder="ghcr.io/your-org/custom-sandbox"
              disabled={!sandboxConfig.enabled}
              data-testid="sandbox-image-input"
            />
          </div>
        </div>

        {/* Kubernetes-specific settings */}
        {sandboxConfig.provider === 'kubernetes' && (
          <div
            className={cn(
              'mt-6 p-4 rounded-lg border border-border bg-surface-subtle transition-all duration-normal',
              sandboxConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            )}
          >
            <div className="flex items-center gap-2 mb-4">
              <Cloud className="h-5 w-5 text-fg-muted" weight="duotone" />
              <span className="text-sm font-medium text-fg">Kubernetes Settings</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <FieldLabel htmlFor="k8s-namespace">Namespace</FieldLabel>
                <TextInput
                  id="k8s-namespace"
                  value={sandboxConfig.namespace ?? 'default'}
                  onChange={(e) =>
                    updateSandboxConfig((prev) => ({ ...prev, namespace: e.target.value }))
                  }
                  placeholder="default"
                  disabled={!sandboxConfig.enabled}
                  data-testid="k8s-namespace-input"
                />
              </div>
              <div>
                <FieldLabel htmlFor="k8s-service-account" hint="optional">
                  Service Account
                </FieldLabel>
                <TextInput
                  id="k8s-service-account"
                  value={sandboxConfig.serviceAccount ?? ''}
                  onChange={(e) =>
                    updateSandboxConfig((prev) => ({ ...prev, serviceAccount: e.target.value }))
                  }
                  placeholder="agent-runner"
                  disabled={!sandboxConfig.enabled}
                  data-testid="k8s-service-account-input"
                />
              </div>
            </div>
          </div>
        )}

        {/* Nomad-specific settings */}
        {sandboxConfig.provider === 'nomad' && (
          <div
            className={cn(
              'mt-6 p-4 rounded-lg border border-border bg-surface-subtle transition-all duration-normal',
              sandboxConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            )}
          >
            <div className="flex items-center gap-2 mb-4">
              <Hexagon className="h-5 w-5 text-fg-muted" weight="duotone" />
              <span className="text-sm font-medium text-fg">Nomad Settings</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <FieldLabel htmlFor="nomad-namespace">Namespace</FieldLabel>
                <TextInput
                  id="nomad-namespace"
                  value={sandboxConfig.nomadNamespace ?? 'default'}
                  onChange={(e) =>
                    updateSandboxConfig((prev) => ({ ...prev, nomadNamespace: e.target.value }))
                  }
                  placeholder="default"
                  disabled={!sandboxConfig.enabled}
                  data-testid="nomad-namespace-input"
                />
              </div>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* General Settings */}
      <SettingsCard>
        <SectionHeader
          icon={Gear}
          title="General Settings"
          description="Configure basic codespace information and behavior."
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <FieldLabel htmlFor="project-name">Codespace Name</FieldLabel>
            <TextInput
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="project-name-input"
            />
          </div>

          <div>
            <FieldLabel htmlFor="project-path" hint="read-only">
              Codespace Path
            </FieldLabel>
            <TextInput
              id="project-path"
              value={project.path}
              readOnly
              className="bg-surface-muted text-fg-muted cursor-not-allowed"
              data-testid="project-path-display"
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel htmlFor="project-description">Description</FieldLabel>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the codespace..."
              rows={2}
              data-testid="project-description-input"
            />
          </div>

          {folders.length > 0 && (
            <div>
              <FieldLabel htmlFor="project-folder">Project</FieldLabel>
              <div className="relative">
                <select
                  id="project-folder"
                  value={projectFolderId}
                  onChange={(e) => setProjectFolderId(e.target.value)}
                  className="w-full appearance-none rounded-[var(--radius)] border border-border bg-surface-subtle px-3 py-2 pl-9 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  data-testid="project-folder-select"
                >
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <FolderSimple
                    className="h-4 w-4 text-fg-subtle"
                    weight={projectFolderId ? 'fill' : 'regular'}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Agent Configuration */}
      <SettingsCard>
        <SectionHeader
          icon={Brain}
          title="Agent Configuration"
          description="Set defaults for AI agents working on this codespace."
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <FieldLabel htmlFor="max-concurrent">Max Concurrent Agents</FieldLabel>
            <div className="flex items-center gap-4">
              <input
                id="max-concurrent"
                type="range"
                min={1}
                max={10}
                value={maxConcurrent}
                onChange={(event) => setMaxConcurrent(Number(event.target.value))}
                className="flex-1 h-2 bg-surface-muted rounded-full appearance-none cursor-pointer accent-accent"
                data-testid="max-agents-slider"
              />
              <span className="w-10 text-center text-lg font-semibold text-fg tabular-nums bg-surface-subtle rounded-lg py-1">
                {maxConcurrent}
              </span>
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="model">Default Model</FieldLabel>
            <Select
              value={config.model ?? 'claude-sonnet-4-6'}
              onValueChange={(value) => setConfig((prev) => ({ ...prev, model: value }))}
            >
              <SelectTrigger id="model">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {AVAILABLE_MODELS.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="default-branch">
              <GitBranch className="inline h-4 w-4 mr-1.5 text-fg-muted" />
              Default Branch
            </FieldLabel>
            <TextInput
              id="default-branch"
              value={config.defaultBranch}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  defaultBranch: event.target.value,
                }))
              }
            />
          </div>

          <div>
            <FieldLabel htmlFor="worktree-root">Worktree Root</FieldLabel>
            <TextInput
              id="worktree-root"
              value={config.worktreeRoot}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  worktreeRoot: event.target.value,
                }))
              }
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel htmlFor="system-prompt" hint="optional">
              System Prompt
            </FieldLabel>
            <Textarea
              id="system-prompt"
              value={config.systemPrompt ?? ''}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  systemPrompt: event.target.value,
                }))
              }
              placeholder="Custom instructions for agents working on this project..."
              rows={4}
            />
          </div>
        </div>
      </SettingsCard>

      {/* Environment Variables */}
      <SettingsCard>
        <SectionHeader
          icon={Key}
          title="Environment Variables"
          description="Securely pass credentials and configuration to sandbox containers."
        />

        <div className="space-y-3">
          {envVars.map((env, index) => (
            <div key={`${env.key}-${index}`} className="flex items-center gap-3">
              <TextInput
                value={env.key}
                onChange={(e) => {
                  setEnvVars((prev) =>
                    prev.map((item, i) =>
                      i === index ? { key: e.target.value, value: item.value } : item
                    )
                  );
                }}
                placeholder="KEY"
                className="flex-1 font-mono text-sm"
                data-testid={`env-var-key-${index}`}
              />
              <span className="text-fg-muted font-mono">=</span>
              <TextInput
                type="password"
                value={env.value}
                onChange={(e) => {
                  setEnvVars((prev) =>
                    prev.map((item, i) =>
                      i === index ? { key: item.key, value: e.target.value } : item
                    )
                  );
                }}
                placeholder="value"
                className="flex-[2] font-mono text-sm"
                data-testid={`env-var-value-${index}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}
                className="text-danger hover:bg-danger/10"
                data-testid={`env-var-delete-${index}`}
              >
                <Trash className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-3 pt-2">
            <TextInput
              value={newEnvKey}
              onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
              placeholder="NEW_KEY"
              className="flex-1 font-mono text-sm"
              data-testid="env-var-new-key"
            />
            <span className="text-fg-muted font-mono">=</span>
            <TextInput
              type="password"
              value={newEnvValue}
              onChange={(e) => setNewEnvValue(e.target.value)}
              placeholder="value"
              className="flex-[2] font-mono text-sm"
              data-testid="env-var-new-value"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (newEnvKey.trim()) {
                  setEnvVars([...envVars, { key: newEnvKey.trim(), value: newEnvValue }]);
                  setNewEnvKey('');
                  setNewEnvValue('');
                }
              }}
              disabled={!newEnvKey.trim()}
              data-testid="env-var-add"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* Sandbox Environment Variables (global setting: sandbox.env) */}
      <SettingsCard>
        <SectionHeader
          icon={Cube}
          title="Sandbox Environment Variables"
          description="Environment variables passed to sandbox containers during agent execution. Use for API tokens, cloud credentials, and configuration."
        />

        {sandboxEnvLoading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-fg-muted">Loading sandbox variables...</span>
          </div>
        ) : (
          <div className="space-y-3">
            {sandboxEnvVars.map((env, index) => (
              <div key={`sandbox-env-${env.key}-${index}`} className="flex items-center gap-3">
                <TextInput
                  value={env.key}
                  onChange={(e) => {
                    setSandboxEnvVars((prev) =>
                      prev.map((item, i) =>
                        i === index ? { key: e.target.value, value: item.value } : item
                      )
                    );
                  }}
                  placeholder="KEY"
                  className="flex-1 font-mono text-sm"
                  data-testid={`sandbox-env-key-${index}`}
                />
                <span className="text-fg-muted font-mono">=</span>
                <div className="relative flex-[2]">
                  <TextInput
                    type={sandboxEnvVisibility[index] ? 'text' : 'password'}
                    value={env.value}
                    onChange={(e) => {
                      setSandboxEnvVars((prev) =>
                        prev.map((item, i) =>
                          i === index ? { key: item.key, value: e.target.value } : item
                        )
                      );
                    }}
                    placeholder="value"
                    className="font-mono text-sm pr-10"
                    data-testid={`sandbox-env-value-${index}`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setSandboxEnvVisibility((prev) => ({
                        ...prev,
                        [index]: !prev[index],
                      }))
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
                    data-testid={`sandbox-env-toggle-${index}`}
                  >
                    {sandboxEnvVisibility[index] ? (
                      <EyeSlash className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSandboxEnvVars((prev) => prev.filter((_, i) => i !== index));
                    setSandboxEnvVisibility((prev) => {
                      const next: Record<number, boolean> = {};
                      for (const [k, v] of Object.entries(prev)) {
                        const ki = Number(k);
                        if (ki < index) next[ki] = v;
                        else if (ki > index) next[ki - 1] = v;
                      }
                      return next;
                    });
                  }}
                  className="text-danger hover:bg-danger/10"
                  data-testid={`sandbox-env-delete-${index}`}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            ))}

            <div className="flex items-center gap-3 pt-2">
              <TextInput
                value={newSandboxEnvKey}
                onChange={(e) => setNewSandboxEnvKey(e.target.value.toUpperCase())}
                placeholder="NEW_KEY"
                className="flex-1 font-mono text-sm"
                data-testid="sandbox-env-new-key"
              />
              <span className="text-fg-muted font-mono">=</span>
              <TextInput
                type="password"
                value={newSandboxEnvValue}
                onChange={(e) => setNewSandboxEnvValue(e.target.value)}
                placeholder="value"
                className="flex-[2] font-mono text-sm"
                data-testid="sandbox-env-new-value"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (newSandboxEnvKey.trim()) {
                    setSandboxEnvVars((prev) => [
                      ...prev,
                      { key: newSandboxEnvKey.trim(), value: newSandboxEnvValue },
                    ]);
                    setNewSandboxEnvKey('');
                    setNewSandboxEnvValue('');
                  }
                }}
                disabled={!newSandboxEnvKey.trim()}
                data-testid="sandbox-env-add"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border mt-4">
              {sandboxEnvSaveStatus === 'saved' && (
                <span className="text-sm text-success animate-in fade-in">
                  Sandbox variables saved
                </span>
              )}
              {sandboxEnvSaveStatus === 'error' && (
                <span className="text-sm text-danger animate-in fade-in">
                  {sandboxEnvErrorMsg ? `Failed to save: ${sandboxEnvErrorMsg}` : 'Failed to save'}
                </span>
              )}
              <Button
                onClick={() => void handleSaveSandboxEnv()}
                disabled={sandboxEnvSaving}
                variant="outline"
                data-testid="sandbox-env-save"
              >
                {sandboxEnvSaving ? 'Saving...' : 'Save Sandbox Variables'}
              </Button>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Actions */}
      <div className="flex items-center justify-between gap-4 pt-2">
        <Button
          variant="destructive"
          onClick={() => setShowDeleteDialog(true)}
          data-testid="delete-project-button"
        >
          <Trash className="h-4 w-4 mr-2" />
          Delete Codespace
        </Button>
        <div className="flex items-center gap-3">
          {saveStatus === 'saved' && (
            <span className="text-sm text-success animate-in fade-in">Settings saved</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-sm text-danger animate-in fade-in">Failed to save</span>
          )}
          <Button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            data-testid="save-settings-button"
          >
            {saveStatus === 'saving' ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </div>

      <DeleteProjectDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        projectName={project.name}
        projectPath={project.path}
        onConfirm={onDelete}
      />
    </div>
  );
}
