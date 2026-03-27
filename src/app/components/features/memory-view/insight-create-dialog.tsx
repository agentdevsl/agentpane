import type React from 'react';
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
import { INPUT_CLASS } from './formatters';
import { useMemory } from './memory-context';
import type { Insight } from './types';

interface InsightCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InsightCreateDialog({
  open,
  onOpenChange,
}: InsightCreateDialogProps): React.JSX.Element {
  const { createInsight } = useMemory();
  const [content, setContent] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [source, setSource] = useState<Insight['source']>('manual');
  const [submitting, setSubmitting] = useState(false);

  function resetForm(): void {
    setContent('');
    setTagsInput('');
    setSource('manual');
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (content.trim().length === 0 || submitting) return;

    setSubmitting(true);
    try {
      const tags = tagsInput
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);

      const success = await createInsight({ content: content.trim(), source, tags });

      if (success) {
        resetForm();
        onOpenChange(false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Insight</DialogTitle>
          <DialogDescription>
            Add a new insight to the memory store for this codespace.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e: React.FormEvent) => void handleSubmit(e)}
          className="flex flex-col gap-4 pt-2"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="insight-content" className="text-sm font-medium text-fg">
              Content
            </label>
            <textarea
              id="insight-content"
              className={`${INPUT_CLASS} h-28 resize-none py-2`}
              value={content}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
              maxLength={4096}
              required
              placeholder="Describe the insight..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="insight-tags" className="text-sm font-medium text-fg">
              Tags
            </label>
            <input
              id="insight-tags"
              type="text"
              className={INPUT_CLASS}
              value={tagsInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTagsInput(e.target.value)}
              placeholder="Comma-separated tags"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="insight-source" className="text-sm font-medium text-fg">
              Source
            </label>
            <select
              id="insight-source"
              className={INPUT_CLASS}
              value={source}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setSource(e.target.value as Insight['source'])
              }
            >
              <option value="manual">Manual</option>
              <option value="agent_derived">Agent Derived</option>
              <option value="dream">Dream</option>
            </select>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={content.trim().length === 0 || submitting}>
              {submitting ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
