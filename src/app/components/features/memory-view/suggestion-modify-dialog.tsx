import type React from 'react';
import { useCallback, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { useMemory } from './memory-context';

interface SuggestionModifyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestion: { id: string; title: string; suggestedContent: string } | null;
}

export function SuggestionModifyDialog({
  open,
  onOpenChange,
  suggestion,
}: SuggestionModifyDialogProps): React.JSX.Element {
  const { modifySuggestion } = useMemory();
  const [content, setContent] = useState(suggestion?.suggestedContent ?? '');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!suggestion || !content.trim()) return;

    setIsSubmitting(true);
    try {
      const success = await modifySuggestion(suggestion.id, content, notes || undefined);
      if (success) {
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [suggestion, content, notes, modifySuggestion, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Modify Suggestion</DialogTitle>
          <DialogDescription>
            {suggestion ? suggestion.title : 'Edit the suggested content before applying.'}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-4">
          <div>
            <label
              htmlFor="modify-content"
              className="mb-1.5 block text-xs font-medium text-fg-muted"
            >
              Modified Content
            </label>
            <textarea
              id="modify-content"
              value={content}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
              rows={12}
              className="w-full rounded-md border border-border bg-surface-muted p-3 text-xs font-mono text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Enter modified content..."
            />
          </div>

          <div>
            <label
              htmlFor="modify-notes"
              className="mb-1.5 block text-xs font-medium text-fg-muted"
            >
              Notes (optional)
            </label>
            <textarea
              id="modify-notes"
              value={notes}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-surface-muted p-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Add notes about your changes..."
            />
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !content.trim()}
          >
            {isSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
