import { Laptop, Moon, Sun } from '@phosphor-icons/react';
import { useState } from 'react';
import { useEventListener } from '@/app/hooks/use-event-listener';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [open, setOpen] = useState(false);

  useMountEffect(() => {
    const stored = window.localStorage.getItem('theme') as ThemeMode | null;
    if (stored) {
      setTheme(stored);
    }
  });

  useEventListener(open ? window : null, 'keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
    }
  });

  useWatchEffect(() => {
    const root = document.documentElement;
    window.localStorage.setItem('theme', theme);

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = prefersDark ? 'dark' : 'light';
      root.classList.toggle('dark', prefersDark);
    } else {
      root.dataset.theme = theme;
      root.classList.toggle('dark', theme === 'dark');
    }
  }, [theme]);

  const options: { value: ThemeMode; label: string; Icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'System', Icon: Laptop },
  ];

  return (
    <div className={cn('relative inline-flex', className)}>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs font-medium text-fg-muted"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="theme-toggle"
      >
        {theme === 'light' ? (
          <Sun className="h-3.5 w-3.5" data-testid="theme-icon-light" />
        ) : theme === 'dark' ? (
          <Moon className="h-3.5 w-3.5" data-testid="theme-icon-dark" />
        ) : (
          <Laptop className="h-3.5 w-3.5" data-testid="theme-icon-system" />
        )}
        <span className="hidden sm:inline">Theme</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-40 rounded-md border border-border bg-surface p-1 shadow-lg"
          data-testid="theme-menu"
        >
          {options.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-xs font-medium text-fg-muted transition duration-fast ease-out',
                theme === value ? 'bg-surface-muted text-fg' : 'hover:bg-surface-subtle'
              )}
              data-testid={`theme-${value}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
