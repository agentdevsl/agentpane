import { useCallback } from 'react';
import { useEventListener } from './use-event-listener';
import { useWatchEffect } from './use-watch-effect';

// =============================================================================
// Types
// =============================================================================

/**
 * Shortcut category for grouping in the help modal
 */
export type ShortcutCategory = 'navigation' | 'actions' | 'views';

/**
 * Keyboard shortcut definition
 */
export interface Shortcut {
  /** The key to trigger the shortcut (e.g., 'p', '1', 'Enter') */
  key: string;
  /** Whether the Command (Mac) or Ctrl (Windows) key must be pressed */
  meta?: boolean;
  /** Whether the Shift key must be pressed */
  shift?: boolean;
  /** Whether the Alt/Option key must be pressed */
  alt?: boolean;
  /** The action to execute when the shortcut is triggered */
  action: () => void;
  /** Human-readable description of the shortcut's purpose */
  description: string;
  /** Optional condition for when the shortcut should be active */
  when?: () => boolean;
  /** Category for grouping in the help modal */
  category?: ShortcutCategory;
}

/**
 * Context value for the shortcuts system
 */
export interface ShortcutsContextValue {
  /** Register a new shortcut. Returns an unregister function. */
  registerShortcut: (shortcut: Shortcut) => () => void;
  /** Unregister a shortcut by its unique key */
  unregisterShortcut: (id: string) => void;
  /** Get all currently registered shortcuts */
  getShortcuts: () => Shortcut[];
  /** Whether the shortcuts system is enabled */
  isEnabled: boolean;
  /** Enable or disable the shortcuts system */
  setEnabled: (enabled: boolean) => void;
  /** Whether the help modal is open */
  isHelpOpen: boolean;
  /** Open or close the help modal */
  setHelpOpen: (open: boolean) => void;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if the current platform is macOS
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform.toLowerCase().includes('mac');
}

/**
 * Check if an element is an input field where keyboard shortcuts should be suppressed
 */
function isInputElement(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;

  const tagName = element.tagName.toLowerCase();

  // Check for standard input elements
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  // Check for contenteditable elements
  if (element.isContentEditable) {
    return true;
  }

  // Check for elements with role="textbox"
  if (element.getAttribute('role') === 'textbox') {
    return true;
  }

  return false;
}

/**
 * Get individual key parts for rendering
 */
export function getShortcutParts(shortcut: Shortcut): string[] {
  const parts: string[] = [];

  if (shortcut.meta) {
    parts.push(isMac() ? '⌘' : 'Ctrl');
  }
  if (shortcut.shift) {
    parts.push(isMac() ? '⇧' : 'Shift');
  }
  if (shortcut.alt) {
    parts.push(isMac() ? '⌥' : 'Alt');
  }

  // Normalize key display
  let keyDisplay = shortcut.key.toUpperCase();
  if (shortcut.key === 'Enter') keyDisplay = '↵';
  if (shortcut.key === 'Escape') keyDisplay = 'Esc';
  if (shortcut.key === '.') keyDisplay = '.';
  if (shortcut.key === '/') keyDisplay = '/';
  if (shortcut.key === '?') keyDisplay = '?';

  parts.push(keyDisplay);

  return parts;
}

/**
 * Create a unique key identifier for a shortcut
 */
export function getShortcutId(shortcut: Pick<Shortcut, 'key' | 'meta' | 'shift' | 'alt'>): string {
  const parts: string[] = [];
  if (shortcut.meta) parts.push('meta');
  if (shortcut.shift) parts.push('shift');
  if (shortcut.alt) parts.push('alt');
  parts.push(shortcut.key.toLowerCase());
  return parts.join('+');
}

/**
 * Check if a keyboard event matches a shortcut definition
 */
function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  // Check modifier keys
  const metaMatches = shortcut.meta
    ? event.metaKey || event.ctrlKey
    : !event.metaKey && !event.ctrlKey;
  const shiftMatches = shortcut.shift ? event.shiftKey : !event.shiftKey;
  const altMatches = shortcut.alt ? event.altKey : !event.altKey;

  // Check the main key
  const keyMatches = event.key.toLowerCase() === shortcut.key.toLowerCase();

  return metaMatches && shiftMatches && altMatches && keyMatches;
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Hook to register a set of keyboard shortcuts with a context
 *
 * @param shortcuts - Array of shortcut definitions
 * @param context - The shortcuts context value
 *
 * @example
 * ```tsx
 * const context = useShortcutsContext();
 * useKeyboardShortcuts([
 *   {
 *     key: 'p',
 *     meta: true,
 *     action: () => setShowProjectPicker(true),
 *     description: 'Open project picker',
 *   },
 * ], context);
 * ```
 */
export function useKeyboardShortcuts(shortcuts: Shortcut[], context: ShortcutsContextValue): void {
  const { registerShortcut, isEnabled } = context;

  useWatchEffect(() => {
    if (!isEnabled) return;

    // Register all shortcuts and collect unregister functions
    const unregisterFns = shortcuts.map((shortcut) => registerShortcut(shortcut));

    // Cleanup: unregister all shortcuts when component unmounts or shortcuts change
    return () => {
      for (const unregister of unregisterFns) {
        unregister();
      }
    };
  }, [shortcuts, registerShortcut, isEnabled]);
}

/**
 * Hook that sets up the global keyboard event listener
 * This should be used once at the app root level
 *
 * @internal Used by ShortcutsProvider
 */
export function useGlobalKeyboardHandler(getShortcuts: () => Shortcut[], isEnabled: boolean): void {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Skip if shortcuts are disabled
      if (!isEnabled) return;

      // Skip if user is typing in an input field
      // Exception: Allow Escape key to work everywhere
      if (event.key !== 'Escape' && isInputElement(event.target)) {
        return;
      }

      const shortcuts = getShortcuts();

      for (const shortcut of shortcuts) {
        if (matchesShortcut(event, shortcut)) {
          // Check if the shortcut should be active
          if (shortcut.when && !shortcut.when()) {
            continue;
          }

          event.preventDefault();
          event.stopPropagation();
          shortcut.action();
          return;
        }
      }
    },
    [getShortcuts, isEnabled]
  );

  useEventListener(typeof window !== 'undefined' ? window : null, 'keydown', handleKeyDown, true);
}
