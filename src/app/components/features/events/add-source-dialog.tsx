import { Check, Copy, Eye, EyeSlash, Plugs, Plus, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { EVENT_SOURCE_TYPES } from '@/db/schema/shared/enums';
import type { CreateEventSourceInput } from '@/lib/events/types';

interface AddSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (data: CreateEventSourceInput) => Promise<
    | {
        webhookSecret: string;
        webhookUrl: string;
      }
    | undefined
  >;
  isAdding?: boolean;
  teams: Array<{ id: string; name: string }>;
}

export function AddSourceDialog({
  open,
  onClose,
  onAdd,
  isAdding = false,
  teams,
}: AddSourceDialogProps): React.JSX.Element | null {
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof EVENT_SOURCE_TYPES)[number]>('github');
  const [teamId, setTeamId] = useState(teams.length === 1 ? (teams[0]?.id ?? '') : '');
  const [error, setError] = useState<string | null>(null);

  // Success phase state
  const [successData, setSuccessData] = useState<{
    webhookUrl: string;
    webhookSecret: string;
  } | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (!teamId) {
      setError('Team is required');
      return;
    }

    try {
      const result = await onAdd({ name: name.trim(), type, teamId });
      if (result) {
        setSuccessData(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create source');
    }
  };

  const handleClose = () => {
    setName('');
    setType('github');
    setTeamId(teams.length === 1 ? (teams[0]?.id ?? '') : '');
    setError(null);
    setSuccessData(null);
    setCopiedUrl(false);
    setCopiedSecret(false);
    setShowSecret(false);
    onClose();
  };

  const copyToClipboard = async (text: string, field: 'url' | 'secret') => {
    await navigator.clipboard.writeText(text);
    if (field === 'url') {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } else {
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div className="relative w-full max-w-md rounded-lg border border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Plugs className="h-5 w-5 text-fg-muted" />
            <h2 className="text-sm font-semibold text-fg">
              {successData ? 'Source Created' : 'Add Event Source'}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-fg-muted hover:bg-surface-subtle hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {successData ? (
          /* Success phase */
          <div className="p-4 space-y-4">
            <div>
              <span className="block text-xs font-medium text-fg-muted mb-1">Webhook URL</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-surface-subtle px-3 py-2 text-xs text-fg break-all">
                  {successData.webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(successData.webhookUrl, 'url')}
                  className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-subtle hover:text-fg"
                >
                  {copiedUrl ? (
                    <Check className="h-4 w-4 text-success-fg" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-fg-muted mb-1">Webhook Secret</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-surface-subtle px-3 py-2 text-xs text-fg break-all">
                  {showSecret ? successData.webhookSecret : '••••••••••••••••••••'}
                </code>
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-subtle hover:text-fg"
                >
                  {showSecret ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => copyToClipboard(successData.webhookSecret, 'secret')}
                  className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-subtle hover:text-fg"
                >
                  {copiedSecret ? (
                    <Check className="h-4 w-4 text-success-fg" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-warning-fg">
                Save this secret — it won't be shown again.
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <Button type="button" onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          /* Form phase */
          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            <div>
              <label htmlFor="source-name" className="block text-xs font-medium text-fg-muted mb-1">
                Name
              </label>
              <input
                id="source-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My GitHub Webhook"
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
                disabled={isAdding}
              />
            </div>

            <div>
              <label htmlFor="source-type" className="block text-xs font-medium text-fg-muted mb-1">
                Type
              </label>
              <select
                id="source-type"
                value={type}
                onChange={(e) => setType(e.target.value as (typeof EVENT_SOURCE_TYPES)[number])}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
                disabled={isAdding}
              >
                {EVENT_SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>

            {teams.length > 1 && (
              <div>
                <label
                  htmlFor="source-team"
                  className="block text-xs font-medium text-fg-muted mb-1"
                >
                  Team
                </label>
                <select
                  id="source-team"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
                  disabled={isAdding}
                >
                  <option value="">Select a team</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {error ? (
              <div className="rounded bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={handleClose} disabled={isAdding}>
                Cancel
              </Button>
              <Button type="submit" disabled={isAdding}>
                <Plus className="mr-1 h-4 w-4" />
                {isAdding ? 'Creating...' : 'Create Source'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
