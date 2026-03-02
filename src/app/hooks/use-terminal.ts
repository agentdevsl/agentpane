/**
 * Terminal Hook
 *
 * Provides terminal I/O access with optimistic input handling
 * and command history.
 *
 * @module app/hooks/use-terminal
 */

import { eq } from '@tanstack/db';
import { useCallback, useMemo, useState } from 'react';
import { useCollectionQuery } from '@/lib/db/use-collection-query';
import { terminalCollection } from '@/lib/sessions/collections';
import { type OptimisticWriteOptions, sendTerminalInput } from '@/lib/sessions/optimistic';
import type { TerminalEvent } from '@/lib/sessions/schema';

/**
 * Result from useTerminal hook
 */
export interface UseTerminalResult {
  /** All terminal lines for the session */
  lines: TerminalEvent[];
  /** User input history (most recent first) */
  inputHistory: string[];
  /** Send a command to the terminal */
  sendCommand: (command: string) => Promise<void>;
  /** Whether a command is currently being sent */
  isSending: boolean;
  /** Last error if a send failed */
  lastError: Error | null;
  /** Clear the last error */
  clearError: () => void;
}

/**
 * Hook for terminal I/O with optimistic updates
 *
 * @param sessionId - The session ID
 * @returns Terminal data and actions
 *
 * @example
 * const { lines, inputHistory, sendCommand, isSending } = useTerminal(sessionId);
 *
 * // Send a command
 * await sendCommand('ls -la');
 *
 * // Use input history for autocomplete
 * const lastCommand = inputHistory[0];
 */
export function useTerminal(sessionId: string): UseTerminalResult {
  const [isSending, setIsSending] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  // Live query for terminal lines
  const { data } = useCollectionQuery<TerminalEvent>(
    (q) =>
      q
        .from({ terminal: terminalCollection })
        .where(({ terminal }: { terminal: TerminalEvent }) => eq(terminal.sessionId, sessionId)),
    [sessionId]
  );

  const lines = data ?? [];

  // Extract input history (user inputs only, most recent first)
  const inputHistory = useMemo(() => {
    return lines
      .filter((line) => line.type === 'input' && line.source === 'user')
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((line) => line.data)
      .slice(0, 50);
  }, [lines]);

  // Send command with optimistic update
  const sendCommand = useCallback(
    async (command: string) => {
      if (!command.trim()) return;

      setIsSending(true);
      setLastError(null);

      const options: OptimisticWriteOptions = {
        onOptimistic: () => {
          // Optimistic update handled by sendTerminalInput
        },
        onConfirm: () => {
          setIsSending(false);
        },
        onRollback: (_event, error) => {
          setIsSending(false);
          setLastError(error);
        },
      };

      await sendTerminalInput(sessionId, command, options);
    },
    [sessionId]
  );

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  return {
    lines,
    inputHistory,
    sendCommand,
    isSending,
    lastError,
    clearError,
  };
}
