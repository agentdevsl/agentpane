/**
 * Shared Suspense fallback components for lazy-loaded dialogs and panels.
 *
 * Replaces the six `fallback={null}` sites flagged in
 * `specs/arch_review_april/08-frontend.md` F08-01: rendering `null` while a
 * lazy chunk is downloading produces a "blank flash" for users on cold caches
 * or slow links. These skeletons give a visible placeholder and also mark the
 * element with `role="status"` / `aria-busy` so assistive tech announces the
 * loading state.
 *
 * Two presets cover the common cases; callers can still pass a custom
 * fallback when a more specialised layout is needed.
 */
import { Skeleton, SkeletonText } from '@/app/components/ui/skeleton';
import { cn } from '@/lib/utils/cn';

/**
 * Placeholder rendered inside a Suspense boundary whose child is a lazy-loaded
 * dialog (NewProjectDialog, NewTaskDialog, AIGenerateDialog, …). Dialogs only
 * mount after the user opens them, so `null` used to flash to an empty stage
 * while the chunk downloaded. This renders an invisible, aria-live region so
 * screen readers announce that content is loading without drawing a visible
 * shell that might conflict with the real dialog's own opening animation.
 */
export function DialogLoadingFallback({
  className,
  label = 'Loading…',
}: {
  className?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="dialog-loading-fallback"
      className={cn('sr-only', className)}
    >
      {label}
    </div>
  );
}
DialogLoadingFallback.displayName = 'DialogLoadingFallback';

/**
 * Placeholder rendered inside a Suspense boundary whose child is a lazy-loaded
 * visible panel (AuditTrailPanel, side panels, etc.). Renders a lightweight
 * skeleton with a title and a few text lines so the layout doesn't jump when
 * the real panel mounts.
 */
export function PanelLoadingFallback({
  className,
  lines = 5,
}: {
  className?: string;
  lines?: number;
}): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="panel-loading-fallback"
      className={cn('flex h-full w-full flex-col gap-3 p-4', className)}
    >
      <Skeleton variant="text" height={18} width="40%" />
      <SkeletonText lines={lines} lineHeight={12} lastLineWidth={60} />
      <span className="sr-only">Loading panel…</span>
    </div>
  );
}
PanelLoadingFallback.displayName = 'PanelLoadingFallback';
