import { Check, Copy, Eye, EyeSlash, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { useWatchEffect } from '@/app/hooks/use-effect-factories';
import { EVENT_SOURCE_TYPES } from '@/db/schema/shared/enums';
import { apiClient } from '@/lib/api/client';
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
}: AddSourceDialogProps): React.JSX.Element {
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
  const [copiedAll, setCopiedAll] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);

  useWatchEffect(() => {
    if (!open || type !== 'github') {
      setGithubConnected(false);
      return;
    }
    let cancelled = false;
    apiClient.github
      .getTokenInfo()
      .then((result) => {
        if (!cancelled) {
          setGithubConnected(result.ok === true && result.data.tokenInfo?.isValid === true);
        }
      })
      .catch(() => {
        if (!cancelled) setGithubConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, type]);

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
    setCopiedAll(false);
    setShowSecret(false);
    onClose();
  };

  const copyToClipboard = async (text: string, field: 'url' | 'secret') => {
    try {
      await navigator.clipboard.writeText(text);
      if (field === 'url') {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 2000);
      } else {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
      }
    } catch {
      // Clipboard API unavailable in insecure contexts — ignore gracefully
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{successData ? 'Source Created' : 'Add Event Source'}</DialogTitle>
        </DialogHeader>

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
              <p className="mt-2 text-xs text-attention">
                Save this secret — it won't be shown again.
              </p>
            </div>

            <div className="rounded-md bg-surface-subtle p-3 text-xs text-fg-muted space-y-1">
              <p className="font-medium text-fg">Setup Instructions</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Go to your repository's Settings &rarr; Webhooks &rarr; Add webhook</li>
                <li>Paste the Webhook URL above into the "Payload URL" field</li>
                <li>
                  Set "Content type" to <code className="text-fg">application/json</code>
                </li>
                <li>Paste the Webhook Secret into the "Secret" field</li>
                <li>Select the events you want to receive</li>
              </ol>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `Webhook URL: ${successData.webhookUrl}\nWebhook Secret: ${successData.webhookSecret}`
                    );
                    setCopiedAll(true);
                    setTimeout(() => setCopiedAll(false), 2000);
                  } catch {
                    // Clipboard API unavailable in insecure contexts
                  }
                }}
              >
                {copiedAll ? (
                  <>
                    <Check className="mr-1 h-4 w-4 text-success-fg" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-4 w-4" />
                    Copy All
                  </>
                )}
              </Button>
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
                    {t.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              {type === 'github' && githubConnected && (
                <span className="ml-2 inline-flex items-center rounded-full bg-success-muted px-2 py-0.5 text-xs font-medium text-success">
                  GitHub Connected
                </span>
              )}
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
              <div role="alert" className="rounded bg-danger-muted px-3 py-2 text-xs text-danger">
                {error}
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={handleClose} disabled={isAdding}>
                Cancel
              </Button>
              <Button type="submit" disabled={isAdding}>
                <Plus className="mr-1 h-4 w-4" />
                {isAdding ? 'Creating...' : 'Create Source'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
