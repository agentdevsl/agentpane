import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import type { EventSource } from '@/lib/events/types';

interface EditSourceDialogProps {
  open: boolean;
  onClose: () => void;
  source: EventSource;
  onSave: (name: string) => Promise<void>;
}

export function EditSourceDialog({
  open,
  onClose,
  source,
  onSave,
}: EditSourceDialogProps): React.JSX.Element {
  const [name, setName] = useState(source.name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Event Source</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-name" className="mb-1 block text-xs font-medium text-fg-muted">
              Name
            </label>
            <input
              id="edit-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              disabled={isSaving}
            />
          </div>
          {error && (
            <div role="alert" className="rounded bg-danger-muted px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
