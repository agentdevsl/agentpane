/**
 * Global API connection health signal for the root shell's
 * `ConnectionStatusBanner`.
 *
 * Combines three signals:
 *   1. `navigator.onLine` — an immediate OS-level disconnect cue.
 *   2. Window `online` / `offline` events — reactive updates without polling.
 *   3. A low-frequency `/api/health` poll (60s) — catches the case where the
 *      network is up but the API server is down or unreachable.
 *
 * F08-01 in `specs/arch_review_april/08-frontend.md` flagged the
 * `ConnectionStatusBanner` component as unmounted. This hook provides the
 * signal so the banner can be rendered once at the root and reflect global
 * connectivity without each view having to plumb its own status.
 */
import { useCallback, useRef, useState } from 'react';
import type { ConnectionStatus } from '@/app/hooks/use-connection-health';
import { useEventListener } from '@/app/hooks/use-event-listener';
import { useInterval } from '@/app/hooks/use-interval';
import { useMountEffect } from '@/app/hooks/use-mount-effect';

/**
 * Poll interval in milliseconds for the `/api/health` probe. The banner
 * already shows the OS-level offline signal instantly via the `offline`
 * event, so the poll is a slow backstop; keeping it long (60s) avoids
 * adding to the dev-only `setInterval` violations noted in CLAUDE.md.
 */
const HEALTH_POLL_MS = 60_000;

/**
 * Request timeout: if the server doesn't answer the health probe within
 * `HEALTH_TIMEOUT_MS`, treat it as degraded. Short enough to avoid a stuck
 * request blocking detection of a real outage.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * On failure we show `reconnecting` first, then escalate to `disconnected`
 * after this many consecutive misses. Prevents a single hiccup from flashing
 * a scary banner.
 */
const FAILURES_BEFORE_DISCONNECTED = 2;

export function useGlobalConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    typeof navigator === 'undefined' || navigator.onLine ? 'connected' : 'disconnected'
  );
  const consecutiveFailuresRef = useRef(0);

  const probeHealth = useCallback(async () => {
    // If the browser already knows we're offline, don't bother.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      consecutiveFailuresRef.current += 1;
      setStatus('disconnected');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/health', {
        method: 'GET',
        signal: controller.signal,
        // Avoid caching — we want the live health of the origin.
        cache: 'no-store',
      });
      if (res.ok) {
        consecutiveFailuresRef.current = 0;
        setStatus('connected');
        return;
      }
      consecutiveFailuresRef.current += 1;
    } catch {
      consecutiveFailuresRef.current += 1;
    } finally {
      clearTimeout(timeout);
    }

    if (consecutiveFailuresRef.current >= FAILURES_BEFORE_DISCONNECTED) {
      setStatus('disconnected');
    } else {
      setStatus('reconnecting');
    }
  }, []);

  // Online / offline events — reactive update without polling.
  useEventListener(typeof window === 'undefined' ? null : window, 'online', () => {
    consecutiveFailuresRef.current = 0;
    setStatus('connected');
  });
  useEventListener(typeof window === 'undefined' ? null : window, 'offline', () => {
    consecutiveFailuresRef.current += 1;
    setStatus('disconnected');
  });

  // Kick off an initial probe on mount; don't await — we want mount to return.
  useMountEffect(() => {
    if (typeof window === 'undefined') return;
    void probeHealth();
  });

  // Slow poll as a backstop for "network up, API down".
  useInterval(
    () => {
      void probeHealth();
    },
    typeof window === 'undefined' ? null : HEALTH_POLL_MS
  );

  return status;
}
