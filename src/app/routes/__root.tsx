import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { GlobalShortcutsWithPicker } from '@/app/components/features/global-shortcuts';
import { Toaster } from '@/app/components/ui/toaster';
import { TooltipProvider } from '@/app/components/ui/tooltip';
import { CodespaceContextProvider } from '@/app/providers/codespace-context';
import { FolderContextProvider } from '@/app/providers/folder-context';
import { ShortcutsProvider } from '@/app/providers/shortcuts-provider';
import type { RouterContext } from '@/app/router';

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message = error instanceof Error ? error.message : 'An unexpected error occurred';

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-8 text-fg">
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-fg-muted">{message}</p>
        <div className="flex justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              reset();
              router.invalidate();
            }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => router.navigate({ to: '/' })}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-surface-subtle"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}

function NotFoundComponent() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-8 text-fg">
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-fg-muted">The page you are looking for does not exist.</p>
        <button
          type="button"
          onClick={() => router.navigate({ to: '/' })}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          Go home
        </button>
      </div>
    </div>
  );
}

function RootComponent() {
  return (
    <ShortcutsProvider>
      <FolderContextProvider>
        <CodespaceContextProvider>
          <TooltipProvider delayDuration={300}>
            <div className="min-h-screen bg-canvas text-fg">
              <Outlet />
              <Toaster />
              <GlobalShortcutsWithPicker />
            </div>
          </TooltipProvider>
        </CodespaceContextProvider>
      </FolderContextProvider>
    </ShortcutsProvider>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: NotFoundComponent,
});
