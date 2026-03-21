import { Check } from '@phosphor-icons/react';
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
import { TextInput } from '@/app/components/ui/text-input';
import { useFolderData } from '@/app/providers/folder-context';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { AVAILABLE_ICONS, FolderIcon } from './folder-rail/folder-icon';

// =============================================================================
// Constants
// =============================================================================

const PRESET_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#a855f7', // purple
];

// =============================================================================
// Helpers
// =============================================================================

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// =============================================================================
// Component
// =============================================================================

interface CreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateFolderDialog({
  open,
  onOpenChange,
}: CreateFolderDialogProps): React.JSX.Element {
  const { refreshFolders, selectFolder } = useFolderData();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState('folder');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName('');
    setSlug('');
    setSlugManuallyEdited(false);
    setSelectedIcon('folder');
    setSelectedColor(PRESET_COLORS[0]);
    setError(null);
  }, []);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newName = e.target.value;
      setName(newName);
      if (!slugManuallyEdited) {
        setSlug(slugify(newName));
      }
    },
    [slugManuallyEdited]
  );

  const handleSlugChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSlug(e.target.value);
    setSlugManuallyEdited(true);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || !slug.trim()) return;

      setIsSubmitting(true);
      setError(null);

      try {
        const result = await apiClient.projectFolders.create({
          name: name.trim(),
          slug: slug.trim(),
          icon: selectedIcon,
          color: selectedColor,
        });

        if (result.ok) {
          await refreshFolders();
          selectFolder(result.data.id);
          onOpenChange(false);
          resetForm();
        } else {
          setError((result.error as { message?: string })?.message ?? 'Failed to create folder');
        }
      } catch {
        setError('An unexpected error occurred');
      } finally {
        setIsSubmitting(false);
      }
    },
    [name, slug, selectedIcon, selectedColor, refreshFolders, selectFolder, onOpenChange, resetForm]
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetForm]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Folder</DialogTitle>
          <DialogDescription>
            Organize your codespaces into folders for easier navigation.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <label htmlFor="folder-name" className="text-sm font-medium text-fg">
              Name
            </label>
            <TextInput
              id="folder-name"
              placeholder="My Folder"
              value={name}
              onChange={handleNameChange}
              autoFocus
              data-testid="create-folder-name"
            />
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <label htmlFor="folder-slug" className="text-sm font-medium text-fg">
              Slug
            </label>
            <TextInput
              id="folder-slug"
              placeholder="my-folder"
              value={slug}
              onChange={handleSlugChange}
              data-testid="create-folder-slug"
            />
            <p className="text-xs text-fg-muted">
              URL-friendly identifier. Auto-generated from the name.
            </p>
          </div>

          {/* Icon picker */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-fg">Icon</span>
            <div className="grid grid-cols-10 gap-1" data-testid="create-folder-icon-picker">
              {AVAILABLE_ICONS.map((iconName) => (
                <button
                  key={iconName}
                  type="button"
                  onClick={() => setSelectedIcon(iconName)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                    selectedIcon === iconName
                      ? 'bg-accent text-white'
                      : 'text-fg-muted hover:bg-surface-subtle hover:text-fg'
                  )}
                  title={iconName}
                >
                  <FolderIcon iconName={iconName} size={16} />
                </button>
              ))}
            </div>
          </div>

          {/* Color picker */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-fg">Color</span>
            <div className="flex flex-wrap gap-2" data-testid="create-folder-color-picker">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setSelectedColor(color)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform',
                    selectedColor === color
                      ? 'scale-110 border-fg'
                      : 'border-transparent hover:scale-105'
                  )}
                  style={{ backgroundColor: color }}
                  title={color}
                >
                  {selectedColor === color && (
                    <Check size={14} weight="bold" className="text-white" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-subtle p-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg text-white"
              style={{ backgroundColor: selectedColor }}
            >
              <FolderIcon iconName={selectedIcon} size={18} weight="fill" />
            </div>
            <div>
              <div className="text-sm font-medium text-fg">{name || 'Folder name'}</div>
              <div className="text-xs text-fg-muted">{slug || 'folder-slug'}</div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-danger" data-testid="create-folder-error">
              {error}
            </p>
          )}

          {/* Actions */}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !slug.trim() || isSubmitting}
              data-testid="create-folder-submit"
            >
              {isSubmitting ? 'Creating...' : 'Create Folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
