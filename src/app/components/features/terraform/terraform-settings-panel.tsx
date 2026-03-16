import { ArrowsClockwise, Eye, EyeSlash, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import { useTerraform } from './terraform-context';
import { formatTimeAgo } from './terraform-utils';

const SYNC_INTERVALS = [
  { value: null, label: 'Manual only' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every 1 hour' },
  { value: 240, label: 'Every 4 hours' },
] as const;

function formatTimeUntil(dateStr: string | null): string {
  if (!dateStr) return 'Manual';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'Due now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function TerraformSettingsPanel(): React.JSX.Element {
  const navigate = useNavigate();
  const {
    registries,
    syncRegistry,
    refreshModules,
    error: contextError,
    clearError,
  } = useTerraform();
  const registry = registries[0];

  const [token, setToken] = useState('');
  const [orgName, setOrgName] = useState('');
  const [syncInterval, setSyncInterval] = useState<number | null>(30);
  const [showToken, setShowToken] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    if (!registry) {
      setOrgName('');
      setSyncInterval(30);
      setToken('');
      setHasToken(false);
      return;
    }

    setOrgName(registry.orgName);
    setSyncInterval(registry.syncIntervalMinutes);
    setToken('');
    setHasToken(registry.hasToken);
  }, [registry]);

  const status = registry?.status ?? 'active';
  const isError = status === 'error';
  const isSyncingStatus = status === 'syncing';

  const isSyncingRef = useRef(false);
  const handleSync = useCallback(async () => {
    if (!registry || isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    clearError();
    try {
      await syncRegistry(registry.id);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [registry, syncRegistry, clearError]);

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current) return;
    if (!orgName.trim()) {
      setSaveError('Organization name is required');
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    setSaveError(null);
    try {
      const normalizedToken = token.trim();
      const hasNewToken = normalizedToken.length > 0;

      if (registry) {
        const updateData: {
          orgName?: string;
          syncIntervalMinutes?: number | null;
          apiToken?: string;
        } = {
          orgName,
          syncIntervalMinutes: syncInterval,
        };
        if (hasNewToken) {
          updateData.apiToken = normalizedToken;
        }
        const result = await apiClient.terraform.updateRegistry(registry.id, updateData);
        if (!result.ok) {
          setSaveError(result.error?.message ?? 'Failed to update registry');
          return;
        }
        setHasToken(true);
        setToken('');
      } else {
        if (!hasNewToken) {
          setSaveError('A valid TFE API token is required to connect a registry');
          return;
        }
        const result = await apiClient.terraform.createRegistry({
          name: orgName,
          orgName,
          apiToken: normalizedToken,
          syncIntervalMinutes: syncInterval ?? undefined,
        });
        if (!result.ok) {
          setSaveError(result.error?.message ?? 'Failed to create registry');
          return;
        }
        setHasToken(true);
        setToken('');
      }
      await refreshModules();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Network error saving settings');
      console.error('[Terraform] Save error:', err);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [registry, orgName, token, syncInterval, refreshModules]);

  const handleDelete = useCallback(async () => {
    if (!registry) return;
    if (!window.confirm('Remove this registry? This action cannot be undone.')) return;
    try {
      const res = await apiClient.terraform.deleteRegistry(registry.id);
      if (res.ok) {
        void navigate({ to: '/terraform' });
      } else {
        setSaveError('Failed to remove registry. Please try again.');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Network error removing registry');
      console.error('[Terraform] Delete error:', err);
    }
  }, [registry, navigate]);

  const handleCancel = useCallback(() => {
    void navigate({ to: '/terraform' });
  }, [navigate]);

  const statusCardBorder = isError
    ? 'border-danger'
    : isSyncingStatus
      ? 'border-accent'
      : 'border-border';

  const displayError = saveError ?? contextError;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 justify-center overflow-y-auto p-8">
        <div className="w-full max-w-[600px]">
          <h1 className="mb-2 text-lg font-semibold tracking-tight">Terraform Registry Settings</h1>
          <p className="mb-6 text-[13px] leading-relaxed text-fg-muted">
            Connect to your HCP Terraform private registry to sync modules for the no-code composer.
          </p>

          {displayError ? (
            <div className="mb-4 rounded-md border border-danger bg-danger-muted p-3">
              <div className="flex items-center gap-2 text-sm text-danger">
                <WarningCircle size={16} />
                {displayError}
              </div>
            </div>
          ) : null}

          {registry ? (
            <div className={`mb-6 rounded-md border bg-surface p-4 ${statusCardBorder}`}>
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-fg">Registry Status</span>
                <StatusBadge status={status} />
              </div>

              {isError && registry.syncError ? (
                <div className="mt-2 rounded bg-danger-muted p-3">
                  <div className="mb-1 text-[13px] font-medium text-danger">
                    Authentication failed
                  </div>
                  <div className="text-xs leading-relaxed text-fg-muted">{registry.syncError}</div>
                </div>
              ) : null}

              {!isError ? (
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                      Modules
                    </div>
                    <div className="text-base font-semibold text-fg">{registry.moduleCount}</div>
                  </div>
                  {isSyncingStatus ? (
                    <>
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                          Progress
                        </div>
                        <div className="font-mono text-sm font-semibold text-fg">---</div>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                          Elapsed
                        </div>
                        <div className="font-mono text-sm font-semibold text-fg">---</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                          Last Sync
                        </div>
                        <div className="font-mono text-sm font-semibold text-fg">
                          {formatTimeAgo(registry.lastSyncedAt)}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                          Next Sync
                        </div>
                        <div className="font-mono text-sm font-semibold text-fg">
                          {formatTimeUntil(registry.nextSyncAt)}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {registry ? (
            <div className="mb-6">
              <button
                type="button"
                onClick={handleSync}
                disabled={isSyncing || isSyncingStatus}
                className={`inline-flex items-center gap-2 rounded-md border border-border bg-surface-hover px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-fg-subtle hover:bg-surface-emphasis ${
                  isSyncing || isSyncingStatus ? 'cursor-not-allowed opacity-60' : ''
                }`}
              >
                {isSyncing || isSyncingStatus ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-transparent border-t-current" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <ArrowsClockwise size={16} />
                    {isError ? 'Retry Sync' : 'Sync Now'}
                  </>
                )}
              </button>
            </div>
          ) : null}

          <hr className="my-6 border-border" />

          <div className="mb-6">
            <label htmlFor="tfe-token" className="mb-2 block text-[13px] font-semibold text-fg">
              TFE API Token
            </label>
            <span className="mb-2 block text-xs text-fg-subtle">
              Your HCP Terraform or Terraform Enterprise API token. Stored encrypted.
            </span>
            {hasToken ? (
              <span className="mb-2 block text-xs text-fg-muted">
                A token is already stored. Leave this blank to keep the existing token.
              </span>
            ) : null}
            <div className="relative flex items-center">
              <input
                id="tfe-token"
                type={showToken ? 'text' : 'password'}
                className={`h-9 w-full rounded-md border bg-surface px-3 pr-10 text-sm text-fg transition-all placeholder:text-fg-subtle hover:border-fg-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-muted ${
                  isError ? 'border-danger' : 'border-border'
                }`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  hasToken
                    ? 'Enter a new token to replace the existing one'
                    : 'Enter your TFE API token'
                }
              />
              <button
                type="button"
                onClick={() => setShowToken((prev) => !prev)}
                className="absolute right-2 flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
                title={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeSlash size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {isError ? (
              <span className="mt-1 flex items-center gap-1 text-xs text-danger">
                <WarningCircle size={12} />
                Token is invalid or expired
              </span>
            ) : null}
          </div>

          <div className="mb-6">
            <label htmlFor="org-name" className="mb-2 block text-[13px] font-semibold text-fg">
              Organization Name
            </label>
            <span className="mb-2 block text-xs text-fg-subtle">
              The HCP Terraform organization that owns the private registry.
            </span>
            <input
              id="org-name"
              type="text"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg transition-all placeholder:text-fg-subtle hover:border-fg-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-muted"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. acme-infrastructure"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="sync-interval" className="mb-2 block text-[13px] font-semibold text-fg">
              Sync Interval
            </label>
            <span className="mb-2 block text-xs text-fg-subtle">
              How often to automatically sync modules from the registry.
            </span>
            <select
              id="sync-interval"
              className="h-9 w-full cursor-pointer appearance-none rounded-md border border-border bg-surface bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%236e7681%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%2C9%2012%2C15%2018%2C9%22%2F%3E%3C%2Fsvg%3E')] bg-[position:right_12px_center] bg-no-repeat px-3 pr-9 text-sm text-fg transition-all hover:border-fg-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-muted"
              value={syncInterval === null ? '' : String(syncInterval)}
              onChange={(e) => {
                const val = e.target.value;
                setSyncInterval(val === '' ? null : Number(val));
              }}
            >
              {SYNC_INTERVALS.map((interval) => (
                <option
                  key={interval.label}
                  value={interval.value === null ? '' : String(interval.value)}
                >
                  {interval.label}
                </option>
              ))}
            </select>
          </div>

          <hr className="my-6 border-border" />

          <div className="flex items-center justify-between pt-1">
            {registry ? (
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-2 rounded-md border border-danger bg-transparent px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-muted"
              >
                <Trash size={16} />
                Remove Registry
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex items-center gap-2 rounded-md border border-transparent bg-transparent px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-md border border-transparent bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-emphasis disabled:opacity-60"
              >
                {isSaving ? (
                  'Saving...'
                ) : registry ? (
                  'Save Settings'
                ) : (
                  <>
                    <Plus size={14} />
                    Connect Registry
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'syncing' | 'error' }): React.JSX.Element {
  const styles = {
    active: { badge: 'bg-success-muted text-success', dot: 'bg-success', label: 'Active' },
    syncing: {
      badge: 'bg-accent-muted text-accent',
      dot: 'bg-accent animate-pulse',
      label: 'Syncing',
    },
    error: { badge: 'bg-danger-muted text-danger', dot: 'bg-danger', label: 'Error' },
  };
  const s = styles[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${s.badge}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
