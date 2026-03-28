import {
  CircleNotch,
  Cloud,
  Cpu,
  FolderOpen,
  Gauge,
  HardDrive,
  Package,
  Pencil,
  Plus,
  Timer,
  Trash,
  TreeStructure,
} from '@phosphor-icons/react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import type { SandboxConfigItem } from '@/lib/api/client';
import { CONFIG_TYPE_BADGES } from './shared.js';

export interface ConfigListProps {
  configs: SandboxConfigItem[];
  isLoading: boolean;
  openCreateEditor: () => void;
  openEditEditor: (config: SandboxConfigItem) => void;
  handleDelete: (config: SandboxConfigItem) => void;
}

export function ConfigList({
  configs,
  isLoading,
  openCreateEditor,
  openEditEditor,
  handleDelete,
}: ConfigListProps): React.JSX.Element {
  return (
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
                      {CONFIG_TYPE_BADGES[config.type] ?? '🐳 Docker'}
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
                      <span className="font-mono font-medium text-fg">{config.memoryMb}</span> MB
                    </span>
                    <span className="flex items-center gap-1">
                      <Cpu className="h-3 w-3" />
                      <span className="font-mono font-medium text-fg">{config.cpuCores}</span> cores
                    </span>
                    <span className="flex items-center gap-1">
                      <TreeStructure className="h-3 w-3" />
                      <span className="font-mono font-medium text-fg">{config.maxProcesses}</span>{' '}
                      PIDs
                    </span>
                    <span className="flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      <span className="font-mono font-medium text-fg">{config.timeoutMinutes}</span>{' '}
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
  );
}
