import { CheckCircle, CircleNotch, Info, Warning, WarningCircle, X } from '@phosphor-icons/react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { useRef, useState, useSyncExternalStore } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';

// =============================================================================
// Types
// =============================================================================

export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastAction {
  label: string;
  onClick: () => void;
  altText?: string;
}

export interface ToastData {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration?: number;
  action?: ToastAction;
  dismissible?: boolean;
  showProgress?: boolean;
  createdAt: number;
}

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: ToastAction;
  dismissible?: boolean;
  showProgress?: boolean;
  id?: string;
}

export interface PromiseMessages<T> {
  loading: string;
  success: string | ((data: T) => string);
  error: string | ((error: Error) => string);
}

// =============================================================================
// Constants
// =============================================================================

const MAX_VISIBLE_TOASTS = 3;

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  default: 5000,
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 3000,
  loading: 0,
};

// =============================================================================
// Toast Store (External Store Pattern)
// =============================================================================

interface ToastState {
  toasts: ToastData[];
}

let toastIdCounter = 0;

function generateId(): string {
  return `toast-${++toastIdCounter}-${Date.now()}`;
}

const toastState: ToastState = { toasts: [] };
const toastListeners = new Set<() => void>();

function emitToastChange(): void {
  for (const listener of toastListeners) {
    listener();
  }
}

function subscribeToToasts(listener: () => void): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

function getToastSnapshot(): ToastData[] {
  return toastState.toasts;
}

function addToast(toast: Omit<ToastData, 'id' | 'createdAt'> & { id?: string }): string {
  const id = toast.id ?? generateId();
  const createdAt = Date.now();
  const newToast: ToastData = { ...toast, id, createdAt };

  toastState.toasts = [...toastState.toasts, newToast];
  emitToastChange();

  const duration = toast.duration ?? DEFAULT_DURATIONS[toast.variant];
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }

  return id;
}

function dismissToast(id: string): void {
  toastState.toasts = toastState.toasts.filter((t) => t.id !== id);
  emitToastChange();
}

function updateToast(id: string, updates: Partial<Omit<ToastData, 'id' | 'createdAt'>>): void {
  toastState.toasts = toastState.toasts.map((t) => {
    if (t.id !== id) return t;

    const updated = { ...t, ...updates };

    if (updates.variant && updates.variant !== 'loading' && t.variant === 'loading') {
      const duration = updates.duration ?? DEFAULT_DURATIONS[updates.variant];
      if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
      }
    }

    return updated;
  });
  emitToastChange();
}

function dismissAllToasts(): void {
  toastState.toasts = [];
  emitToastChange();
}

// =============================================================================
// Toast Variants (CVA)
// =============================================================================

const toastVariants = cva(
  [
    'group relative flex items-start gap-3',
    'min-w-[320px] max-w-[420px] p-4',
    'border rounded-md',
    'shadow-lg',
    'pointer-events-auto overflow-hidden',
    // Entry animation
    'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=open]:fade-in-0',
    // Exit animation
    'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-0',
    'data-[state=open]:duration-200 data-[state=closed]:duration-150',
    // Swipe animations
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-[transform_200ms_ease-out]',
    'data-[swipe=end]:animate-out data-[swipe=end]:slide-out-to-right-full',
  ],
  {
    variants: {
      variant: {
        default: [
          'bg-surface border-border',
          'text-fg',
          '[&_[data-icon]]:text-fg-muted',
          '[&_[data-progress]]:bg-fg-muted',
        ],
        success: [
          'bg-surface border-success',
          'text-fg',
          '[&_[data-icon]]:text-success',
          '[&_[data-progress]]:bg-success',
        ],
        error: [
          'bg-surface border-danger',
          'text-fg',
          '[&_[data-icon]]:text-danger',
          '[&_[data-progress]]:bg-danger',
        ],
        warning: [
          'bg-surface border-attention',
          'text-fg',
          '[&_[data-icon]]:text-attention',
          '[&_[data-progress]]:bg-attention',
        ],
        info: [
          'bg-surface border-accent',
          'text-fg',
          '[&_[data-icon]]:text-accent',
          '[&_[data-progress]]:bg-accent',
        ],
        loading: ['bg-surface border-border', 'text-fg', '[&_[data-icon]]:text-fg-muted'],
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

// =============================================================================
// Icons by Variant
// =============================================================================

const toastIcons: Record<
  ToastVariant,
  React.ComponentType<{ className?: string; weight?: 'fill' | 'regular' | 'bold' }>
> = {
  default: Info,
  success: CheckCircle,
  error: WarningCircle,
  warning: Warning,
  info: Info,
  loading: CircleNotch,
};

// =============================================================================
// Progress Bar Hook
// =============================================================================

function useToastProgress(duration: number, onComplete: () => void) {
  const [isPaused, setIsPaused] = useState(false);
  const [remainingTime, setRemainingTime] = useState(duration);
  const startTimeRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useWatchEffect(() => {
    if (duration === 0 || isPaused) return;

    startTimeRef.current = Date.now();
    timerRef.current = setTimeout(onComplete, remainingTime);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [duration, isPaused, remainingTime, onComplete]);

  const pause = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      const elapsed = Date.now() - startTimeRef.current;
      setRemainingTime((prev) => Math.max(prev - elapsed, 0));
    }
    setIsPaused(true);
  };

  const resume = () => {
    setIsPaused(false);
  };

  return { pause, resume, isPaused, remainingTime };
}

// =============================================================================
// ARIA Attributes by Variant
// =============================================================================

function getAriaAttributes(variant: ToastVariant) {
  switch (variant) {
    case 'error':
    case 'warning':
      return {
        role: 'alert' as const,
        'aria-live': 'assertive' as const,
        'aria-atomic': true,
      };
    default:
      return {
        role: 'status' as const,
        'aria-live': 'polite' as const,
        'aria-atomic': true,
      };
  }
}

// =============================================================================
// Toast Item Component
// =============================================================================

interface ToastItemProps extends VariantProps<typeof toastVariants> {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isOpen, setIsOpen] = useState(true);
  const {
    id,
    variant = 'default',
    title,
    description,
    duration = 5000,
    action,
    dismissible = true,
    showProgress = false,
  } = toast;

  const handleComplete = () => {
    setIsOpen(false);
  };

  const { pause, resume, isPaused, remainingTime } = useToastProgress(duration, handleComplete);

  const Icon = toastIcons[variant];
  const ariaAttrs = getAriaAttributes(variant);

  return (
    <ToastPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          // Delay removal to allow exit animation
          setTimeout(() => onDismiss(id), 150);
        }
        setIsOpen(open);
      }}
      duration={duration || Number.POSITIVE_INFINITY}
      className={cn(toastVariants({ variant }))}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
      {...ariaAttrs}
    >
      {/* Icon */}
      <div data-icon className="flex-shrink-0 mt-0.5">
        <Icon
          className={cn('w-5 h-5', variant === 'loading' && 'animate-spin')}
          weight={variant === 'loading' ? 'regular' : 'fill'}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <ToastPrimitive.Title className="text-sm font-medium text-fg">{title}</ToastPrimitive.Title>

        {description && (
          <ToastPrimitive.Description className="mt-1 text-xs text-fg-muted">
            {description}
          </ToastPrimitive.Description>
        )}

        {action && (
          <ToastPrimitive.Action altText={action.altText ?? action.label} asChild>
            <button
              type="button"
              onClick={action.onClick}
              className={cn(
                'mt-3 inline-flex items-center justify-center',
                'h-7 px-3 text-xs font-medium',
                'bg-surface-muted text-fg rounded',
                'border border-border',
                'hover:bg-surface-emphasis hover:border-fg-subtle',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted',
                'transition-colors duration-fast'
              )}
            >
              {action.label}
            </button>
          </ToastPrimitive.Action>
        )}
      </div>

      {/* Close Button */}
      {dismissible && (
        <ToastPrimitive.Close
          aria-label="Dismiss notification"
          className={cn(
            'flex-shrink-0 inline-flex items-center justify-center',
            'w-6 h-6 rounded',
            'text-fg-muted hover:text-fg',
            'hover:bg-surface-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted',
            'transition-colors duration-fast',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <X className="w-4 h-4" weight="bold" />
        </ToastPrimitive.Close>
      )}

      {/* Progress Bar */}
      {showProgress && duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-surface-muted overflow-hidden rounded-b-md">
          <div
            data-progress
            className={cn(
              'h-full transition-[width]',
              isPaused ? 'transition-none' : 'duration-100 ease-linear'
            )}
            style={{ width: `${(remainingTime / duration) * 100}%` }}
          />
        </div>
      )}
    </ToastPrimitive.Root>
  );
}

// =============================================================================
// Toast Provider & Viewport
// =============================================================================

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>) => (
  <ToastPrimitive.Viewport
    className={cn(
      'fixed top-4 right-4 z-50 flex flex-col gap-2 w-[420px] max-w-[calc(100vw-32px)] outline-none',
      className
    )}
    {...props}
  />
);

// =============================================================================
// Toaster Component (renders toasts from store)
// =============================================================================

interface ToasterContentProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

function ToasterContent({ toasts, onDismiss }: ToasterContentProps) {
  // Show only the most recent toasts up to MAX_VISIBLE_TOASTS
  const visibleToasts = toasts.slice(-MAX_VISIBLE_TOASTS);

  return (
    <>
      {visibleToasts.map((toastData) => (
        <ToastItem key={toastData.id} toast={toastData} onDismiss={onDismiss} />
      ))}
    </>
  );
}

// Re-export for external use
export { ToasterContent, ToastItem };

// =============================================================================
// Toaster Component (complete implementation with store integration)
// =============================================================================

/**
 * Toaster component that renders all active toasts.
 *
 * This component should be placed once at the root of your application.
 *
 * @example
 * ```tsx
 * import { Toaster } from '@/app/components/ui/toast';
 *
 * export function App() {
 *   return (
 *     <>
 *       <YourAppContent />
 *       <Toaster />
 *     </>
 *   );
 * }
 * ```
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToToasts, getToastSnapshot, getToastSnapshot);

  // Show only the most recent toasts up to MAX_VISIBLE_TOASTS
  const visibleToasts = toasts.slice(-MAX_VISIBLE_TOASTS);

  return (
    <ToastProvider swipeDirection="right">
      {visibleToasts.map((toastData) => (
        <ToastItem key={toastData.id} toast={toastData} onDismiss={dismissToast} />
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}

// =============================================================================
// Standalone toast Object (for use outside React components)
// =============================================================================

/**
 * Standalone toast API for use outside React components.
 *
 * @example
 * ```tsx
 * import { toast } from '@/app/components/ui/toast';
 *
 * // Basic usage
 * toast.success('Saved successfully');
 * toast.error('Failed to save', 'Check your connection');
 * toast.warning('Low disk space');
 * toast.info('New version available');
 *
 * // With action button
 * toast.success('File deleted', {
 *   description: 'This action can be undone',
 *   action: { label: 'Undo', onClick: () => undoDelete() }
 * });
 *
 * // Promise pattern (loading -> success/error)
 * await toast.promise(saveData(), {
 *   loading: 'Saving...',
 *   success: 'Saved!',
 *   error: 'Failed to save'
 * });
 *
 * // With progress bar
 * toast.info('Processing...', { showProgress: true, duration: 5000 });
 * ```
 */
export const toast = {
  show: (options: Omit<ToastData, 'id' | 'variant' | 'createdAt'> & { variant?: ToastVariant }) =>
    addToast({ variant: 'default', ...options }),

  success: (title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'success', title, ...options });
  },

  error: (title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'error', title, ...options });
  },

  warning: (title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'warning', title, ...options });
  },

  info: (title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'info', title, ...options });
  },

  loading: (title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'loading', title, dismissible: false, ...options });
  },

  promise: async <T,>(
    promiseOrFn: Promise<T> | (() => Promise<T>),
    messages: PromiseMessages<T>
  ): Promise<T> => {
    const id = addToast({
      variant: 'loading',
      title: messages.loading,
      duration: 0,
      dismissible: false,
    });

    try {
      const result = await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);

      updateToast(id, {
        variant: 'success',
        title: typeof messages.success === 'function' ? messages.success(result) : messages.success,
        duration: DEFAULT_DURATIONS.success,
        dismissible: true,
      });

      return result;
    } catch (err) {
      const caughtError = err instanceof Error ? err : new Error(String(err));

      updateToast(id, {
        variant: 'error',
        title: typeof messages.error === 'function' ? messages.error(caughtError) : messages.error,
        duration: DEFAULT_DURATIONS.error,
        dismissible: true,
      });

      throw caughtError;
    }
  },

  dismiss: dismissToast,
  update: updateToast,
  dismissAll: dismissAllToasts,
};

// =============================================================================
// Legacy Exports (for backwards compatibility)
// =============================================================================

export const Toast = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>) => (
  <ToastPrimitive.Root
    className={cn(
      'relative flex w-full items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm text-fg shadow-lg',
      className
    )}
    {...props}
  />
);

export const ToastTitle = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>) => (
  <ToastPrimitive.Title className={cn('font-medium text-fg', className)} {...props} />
);

export const ToastDescription = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>) => (
  <ToastPrimitive.Description className={cn('text-xs text-fg-muted', className)} {...props} />
);

export const ToastClose = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>) => (
  <ToastPrimitive.Close
    className={cn('ml-auto text-fg-muted transition hover:text-fg', className)}
    {...props}
  >
    <X className="h-4 w-4" weight="bold" />
  </ToastPrimitive.Close>
);
