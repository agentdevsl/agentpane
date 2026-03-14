import { useCallback, useSyncExternalStore } from 'react';
import type { ToastAction, ToastVariant } from '@/app/components/ui/toast';

// =============================================================================
// Types
// =============================================================================

export type { ToastAction, ToastVariant };

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
// Default Durations by Variant
// =============================================================================

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  default: 5000,
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 3000,
  loading: 0, // Indefinite
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

const state: ToastState = { toasts: [] };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastData[] {
  return state.toasts;
}

// =============================================================================
// Toast Store Actions
// =============================================================================

function addToast(toast: Omit<ToastData, 'id' | 'createdAt'> & { id?: string }): string {
  const id = toast.id ?? generateId();
  const createdAt = Date.now();
  const newToast: ToastData = { ...toast, id, createdAt };

  state.toasts = [...state.toasts, newToast];
  emit();

  const duration = toast.duration ?? DEFAULT_DURATIONS[toast.variant];
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }

  return id;
}

function dismissToast(id: string): void {
  state.toasts = state.toasts.filter((t) => t.id !== id);
  emit();
}

function updateToast(id: string, updates: Partial<Omit<ToastData, 'id' | 'createdAt'>>): void {
  state.toasts = state.toasts.map((t) => {
    if (t.id !== id) return t;

    const updated = { ...t, ...updates };

    // If updating to a non-loading variant with a duration, schedule dismiss
    if (updates.variant && updates.variant !== 'loading' && t.variant === 'loading') {
      const duration = updates.duration ?? DEFAULT_DURATIONS[updates.variant];
      if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
      }
    }

    return updated;
  });
  emit();
}

function dismissAllToasts(): void {
  state.toasts = [];
  emit();
}

// =============================================================================
// useToast Hook
// =============================================================================

export function useToast() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const show = useCallback(
    (options: Omit<ToastData, 'id' | 'variant' | 'createdAt'> & { variant?: ToastVariant }) => {
      return addToast({ variant: 'default', ...options });
    },
    []
  );

  const success = useCallback((title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'success', title, ...options });
  }, []);

  const error = useCallback((title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'error', title, ...options });
  }, []);

  const warning = useCallback((title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'warning', title, ...options });
  }, []);

  const info = useCallback((title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'info', title, ...options });
  }, []);

  const loading = useCallback((title: string, descriptionOrOptions?: string | ToastOptions) => {
    const options =
      typeof descriptionOrOptions === 'string'
        ? { description: descriptionOrOptions }
        : (descriptionOrOptions ?? {});
    return addToast({ variant: 'loading', title, dismissible: false, ...options });
  }, []);

  const promise = useCallback(
    async <T>(
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
          title:
            typeof messages.success === 'function' ? messages.success(result) : messages.success,
          duration: DEFAULT_DURATIONS.success,
          dismissible: true,
        });

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        updateToast(id, {
          variant: 'error',
          title: typeof messages.error === 'function' ? messages.error(error) : messages.error,
          duration: DEFAULT_DURATIONS.error,
          dismissible: true,
        });

        throw error;
      }
    },
    []
  );

  const dismiss = useCallback((id: string) => {
    dismissToast(id);
  }, []);

  const update = useCallback(
    (id: string, updates: Partial<Omit<ToastData, 'id' | 'createdAt'>>) => {
      updateToast(id, updates);
    },
    []
  );

  const dismissAll = useCallback(() => {
    dismissAllToasts();
  }, []);

  return {
    toasts,
    show,
    success,
    error,
    warning,
    info,
    loading,
    promise,
    dismiss,
    update,
    dismissAll,
  };
}

// =============================================================================
// Standalone toast Object (for use outside React components)
// =============================================================================

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

  promise: async <T>(
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
      const error = err instanceof Error ? err : new Error(String(err));

      updateToast(id, {
        variant: 'error',
        title: typeof messages.error === 'function' ? messages.error(error) : messages.error,
        duration: DEFAULT_DURATIONS.error,
        dismissible: true,
      });

      throw error;
    }
  },

  dismiss: dismissToast,
  update: updateToast,
  dismissAll: dismissAllToasts,
};
