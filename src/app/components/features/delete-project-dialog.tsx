import { Folder, Warning } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { Switch } from '@/app/components/ui/switch';
import { TextInput } from '@/app/components/ui/text-input';
import { cn } from '@/lib/utils/cn';

interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  projectPath?: string;
  onConfirm: (options: { deleteFiles: boolean }) => Promise<void>;
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectName,
  projectPath,
  onConfirm,
}: DeleteProjectDialogProps): React.JSX.Element {
  const [confirmText, setConfirmText] = useState('');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConfirmValid = confirmText === projectName;

  async function handleDelete(): Promise<void> {
    if (!isConfirmValid) return;

    setIsDeleting(true);
    setError(null);

    try {
      await onConfirm({ deleteFiles });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete codespace');
    } finally {
      setIsDeleting(false);
    }
  }

  function handleOpenChange(newOpen: boolean): void {
    if (!newOpen) {
      setConfirmText('');
      setDeleteFiles(false);
      setError(null);
    }
    onOpenChange(newOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="delete-project-dialog">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/20">
              <Warning className="h-5 w-5 text-danger" weight="fill" />
            </div>
            <div>
              <DialogTitle>Delete codespace</DialogTitle>
              <DialogDescription>This action cannot be undone.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <p className="text-sm text-fg-muted">
            This will permanently delete the codespace{' '}
            <span className="font-semibold text-fg">{projectName}</span> and all associated data
            including tasks, agents, and sessions.
          </p>

          {/* Delete files option */}
          {projectPath && (
            <div
              className={cn(
                'flex items-start gap-3 rounded-lg border p-4 transition-colors',
                deleteFiles ? 'border-danger/50 bg-danger/10' : 'border-border bg-surface-subtle'
              )}
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Folder
                    className={cn('h-5 w-5', deleteFiles ? 'text-danger' : 'text-fg-muted')}
                    weight={deleteFiles ? 'fill' : 'regular'}
                  />
                  <span className="font-medium text-fg">Also delete codespace files</span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  Permanently delete all files at:{' '}
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono">
                    {projectPath}
                  </code>
                </p>
                {deleteFiles && (
                  <p className="mt-2 text-sm font-medium text-danger">
                    ⚠️ This will permanently delete all source code and cannot be recovered!
                  </p>
                )}
              </div>
              <Switch
                checked={deleteFiles}
                onCheckedChange={setDeleteFiles}
                data-testid="delete-files-toggle"
              />
            </div>
          )}

          <div className="rounded-md border border-danger/40 bg-danger/10 p-3">
            <p className="text-sm text-fg">
              Type <span className="font-mono font-semibold">{projectName}</span> to confirm
              deletion.
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-xs font-medium uppercase tracking-wide text-fg-muted"
              htmlFor="confirm-delete"
            >
              Codespace name
            </label>
            <TextInput
              id="confirm-delete"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={projectName}
              data-testid="delete-confirm-input"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-danger" data-testid="delete-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!isConfirmValid || isDeleting}
            data-testid="confirm-delete-button"
          >
            {isDeleting ? 'Deleting...' : 'Delete codespace'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
